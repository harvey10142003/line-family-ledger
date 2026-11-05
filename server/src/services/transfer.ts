// 轉帳引擎（財務中樞 P1-4，規格 2.5、3.10.1）：建立、撤銷、對帳狀態的唯一出口。
//
// 不變式（test/transfer-engine.db.test.ts 守著）：
// 1. 轉帳本身不算收支：家庭當月收入、支出只會因為「連帶的利息、手續費」而變。
// 2. 夫妻互轉（SPOUSE）家庭總額不變，只動兩人各自的淨資產。
// 3. 撤銷後帳戶餘額、信用卡帳單已繳金額、負債剩餘本金完全回到轉帳前；撤銷不刪轉帳本身（留 undoneAt）。
//
// 權限（AccessScope，D10）：錢從哪裡出去，那一端就要「能改」（共同或本人的）；
// 錢進去的那一端只要看得到即可（同舊版轉帳規則）——但若連帶的收支要記在那個帳戶上，那個帳戶也要能改。
// 規則（組合、連帶收支、帳單狀態）全部在 lib/transfer-rules.ts。
import type { Prisma, ReconcileStatus, TransferKind, TransferSource } from '@prisma/client';
import { prisma } from '../prisma';
import { AccessError, type AccessScope } from '../lib/access';
import {
  checkShape,
  checkSplit,
  isTransferKind,
  liabilityEffect,
  linkedEntries,
  LINKED_CATEGORY,
  money,
  statementStatus,
  TransferRuleError,
  type Endpoint,
  type LinkedEntry,
} from '../lib/transfer-rules';
import { taipeiNoon } from '../lib/time-tw';
import { HIDDEN_ACCOUNT_NAME } from './transaction';

type Tx = Prisma.TransactionClient;

export const KIND_LABEL: Record<TransferKind, string> = {
  ACCOUNT: '轉帳',
  CARD_PAYMENT: '繳卡費',
  CASH_WITHDRAW: '提領現金',
  CASH_DEPOSIT: '存入現金',
  TIME_DEPOSIT: '定存',
  LOAN_REPAY: '還款',
  LEND: '借出',
  BORROW: '借入',
  COLLECT: '收回借款',
  SPOUSE: '夫妻互轉',
};

const ROLE_LABEL = { INTEREST_EXPENSE: '利息', INTEREST_INCOME: '利息收入', FEE: '手續費' } as const;

const SOURCES: TransferSource[] = ['TEXT', 'MANUAL', 'STATEMENT', 'PASSBOOK', 'EMAIL'];

export type CreateTransferInput = {
  kind?: unknown; // 不給＝ACCOUNT（舊版 LIFF 表單只送 from/to/amount）
  fromAccountId?: unknown;
  fromLiabilityId?: unknown;
  toAccountId?: unknown;
  toCreditCardId?: unknown;
  toLiabilityId?: unknown;
  // 借出／借入的對象還不存在時新建（例如「借小明 5000」）
  newLiability?: { name?: unknown; lender?: unknown; ownerMemberId?: unknown; visibility?: unknown } | null;
  cardStatementId?: unknown; // 繳卡費沖哪一期；不給＝該卡最近一期還沒繳清的
  amount?: unknown; // 本金／轉帳金額（不含利息、手續費）
  interest?: unknown;
  fee?: unknown;
  total?: unknown; // 使用者說的總額（有給就檢查 本金＋利息＋手續費＝總額）
  note?: unknown;
  transferredAt?: unknown; // YYYY-MM-DD（台北）；不給＝現在
  source?: unknown;
  confirmOverpay?: unknown; // 繳卡費超過本期應繳時，要明確確認才收（溢繳）
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const n = (d: unknown): number => Number(d ?? 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

async function loadAccount(tx: Tx, familyId: string, id: string): Promise<Endpoint> {
  const a = await tx.account.findFirst({ where: { id, familyId }, select: { id: true, type: true, ownerMemberId: true } });
  if (!a) throw new AccessError(404, 'not_found', 'account not found');
  return { type: 'ACCOUNT', id: a.id, accountType: a.type, ownerMemberId: a.ownerMemberId };
}

async function loadLiability(tx: Tx, familyId: string, id: string): Promise<Endpoint> {
  const l = await tx.liability.findFirst({ where: { id, familyId }, select: { id: true, direction: true } });
  if (!l) throw new AccessError(404, 'not_found', 'liability not found');
  return { type: 'LIABILITY', id: l.id, direction: l.direction };
}

async function categoryFor(tx: Tx, familyId: string, role: LinkedEntry['role']): Promise<string> {
  const c = LINKED_CATEGORY[role];
  const cat = await tx.category.upsert({
    where: { familyId_name: { familyId, name: c.name } },
    update: {},
    create: { familyId, name: c.name, type: c.type, sortOrder: 50 },
  });
  if (cat.type !== c.type) throw new Error(`category ${c.name} exists with a different type`);
  return cat.id;
}

/** 依 statementId 取帳單；沒給就找該卡最近一期還沒繳清的（沒有就不沖任何一期）。 */
async function pickStatement(tx: Tx, familyId: string, cardId: string, statementId: string | null) {
  if (statementId) {
    const s = await tx.cardStatement.findFirst({ where: { id: statementId, familyId, cardId } });
    if (!s) throw new TransferRuleError('invalid_shape', 'cardStatementId does not belong to this card');
    return s;
  }
  return tx.cardStatement.findFirst({ where: { familyId, cardId, status: { not: 'PAID' } }, orderBy: { statementDate: 'desc' } });
}

/** 帳單已繳金額加 delta 後重算狀態（在交易內做，UPDATE 會鎖住該列，同時繳兩次也不會算錯）。 */
async function bumpStatement(tx: Tx, id: string, delta: number, now: Date) {
  const s = await tx.cardStatement.update({ where: { id }, data: { paidAmount: { increment: delta } } });
  const st = statementStatus(n(s.newBalance), n(s.paidAmount), s.dueDate, now);
  await tx.cardStatement.update({ where: { id }, data: { status: st.status } });
  return { id, newBalance: n(s.newBalance), paidAmount: n(s.paidAmount), ...st };
}

async function applyLiability(tx: Tx, liabilityId: string, current: number, principalToo: boolean) {
  if (current < 0) {
    // 還款／收回：剩餘本金不能被扣成負的（多還的要先改對帳值或拆成利息、手續費）
    const amt = -current;
    const r = await tx.liability.updateMany({
      where: { id: liabilityId, currentPrincipal: { gte: amt } },
      data: { currentPrincipal: { decrement: amt } },
    });
    if (r.count === 0) {
      const l = await tx.liability.findUnique({ where: { id: liabilityId }, select: { currentPrincipal: true } });
      throw new TransferRuleError('exceeds_principal', `本金 ${amt} 超過剩餘本金 ${n(l?.currentPrincipal)}`, 400, {
        currentPrincipal: n(l?.currentPrincipal),
      });
    }
  } else {
    await tx.liability.update({
      where: { id: liabilityId },
      data: { currentPrincipal: { increment: current }, ...(principalToo ? { principal: { increment: current } } : {}) },
    });
  }
}

export async function createTransfer(familyId: string, memberId: string, input: CreateTransferInput, scope: AccessScope, now: Date = new Date()) {
  const kind: TransferKind = input.kind === undefined || input.kind === null ? 'ACCOUNT' : isTransferKind(input.kind) ? input.kind : (() => {
    throw new TransferRuleError('invalid_kind', `unknown kind ${String(input.kind)}`);
  })();
  const amount = money(input.amount, 'amount');
  const interest = input.interest == null || input.interest === '' ? 0 : money(input.interest, 'interest', { allowZero: true });
  const fee = input.fee == null || input.fee === '' ? 0 : money(input.fee, 'fee', { allowZero: true });
  const total = input.total == null || input.total === '' ? null : money(input.total, 'total');
  checkSplit(total, amount, interest, fee);
  const transferredAt = input.transferredAt == null || input.transferredAt === '' ? now : taipeiNoon(input.transferredAt);
  if (!transferredAt) throw new TransferRuleError('invalid_shape', 'invalid transferredAt');
  const source: TransferSource = typeof input.source === 'string' && (SOURCES as string[]).includes(input.source) ? (input.source as TransferSource) : 'MANUAL';

  const fromAccountId = str(input.fromAccountId);
  const fromLiabilityId = str(input.fromLiabilityId);
  const toAccountId = str(input.toAccountId);
  const toCreditCardId = str(input.toCreditCardId);
  let toLiabilityId = str(input.toLiabilityId);
  let fromLiabilityIdFinal = fromLiabilityId;
  if ([fromAccountId, fromLiabilityId].filter(Boolean).length > 1 || [toAccountId, toCreditCardId, toLiabilityId].filter(Boolean).length > 1) {
    throw new TransferRuleError('invalid_shape', '來源、目的各只能填一個');
  }
  const wantsNewLiability = !!input.newLiability && (kind === 'LEND' || kind === 'BORROW');
  if (input.newLiability && !wantsNewLiability) throw new TransferRuleError('invalid_shape', 'newLiability only for LEND/BORROW');
  if (wantsNewLiability && (kind === 'LEND' ? toLiabilityId : fromLiabilityId)) {
    throw new TransferRuleError('invalid_shape', 'give either an existing liability or newLiability');
  }

  return prisma.$transaction(async (tx) => {
    // ---- 權限：先檢查（看不到的回 404，不透露存在；不能動的回 403）----
    if (fromAccountId) scope.assertAccountWritable(fromAccountId);
    if (fromLiabilityId) scope.assertLiabilityWritable(fromLiabilityId);
    if (toCreditCardId) scope.assertCardTargetable(toCreditCardId);
    if (toLiabilityId) scope.assertLiabilityTargetable(toLiabilityId);
    if (toAccountId) scope.assertAccountTargetable(toAccountId);

    // ---- 新建借出／借入對象（本金從 0 起，下面套用這筆轉帳後＝金額）----
    if (wantsNewLiability) {
      const nl = input.newLiability!;
      const name = str(nl.name);
      if (!name) throw new TransferRuleError('invalid_shape', 'newLiability.name required');
      const own = scope.resolveOwnership(null, { ownerMemberId: nl.ownerMemberId, visibility: nl.visibility });
      const created = await tx.liability.create({
        data: {
          familyId,
          name,
          lender: str(nl.lender) ?? name,
          direction: kind === 'LEND' ? 'LENT' : 'BORROWED',
          kind: 'FAMILY',
          method: 'FREE',
          principal: 0,
          currentPrincipal: 0,
          ...own,
        },
      });
      if (kind === 'LEND') toLiabilityId = created.id;
      else fromLiabilityIdFinal = created.id;
    }

    // ---- 端點與組合 ----
    const from = fromAccountId ? await loadAccount(tx, familyId, fromAccountId) : fromLiabilityIdFinal ? await loadLiability(tx, familyId, fromLiabilityIdFinal) : null;
    let to: Endpoint | null = null;
    if (toAccountId) to = await loadAccount(tx, familyId, toAccountId);
    else if (toCreditCardId) {
      const c = await tx.creditCard.findFirst({ where: { id: toCreditCardId, familyId }, select: { id: true } });
      if (!c) throw new AccessError(404, 'not_found', 'credit card not found');
      to = { type: 'CARD', id: c.id };
    } else if (toLiabilityId) to = await loadLiability(tx, familyId, toLiabilityId);
    checkShape(kind, from, to);

    const linked = linkedEntries(kind, from!, to!, { interest, fee });
    // 連帶收支要記在帳戶上：那個帳戶也必須能改（D10：不能在對方的個人帳戶上記支出）
    for (const e of linked) scope.assertAccountWritable(e.accountId);

    // ---- 連帶收支（利息、手續費）：一般交易，會算進收支 ----
    const accOwner = new Map<string, string | null>();
    for (const e of [from, to]) if (e?.type === 'ACCOUNT') accOwner.set(e.id, e.ownerMemberId);
    const linkedIds: string[] = [];
    for (const e of linked) {
      const t = await tx.transaction.create({
        data: {
          familyId,
          memberId,
          categoryId: await categoryFor(tx, familyId, e.role),
          accountId: e.accountId,
          amount: e.amount,
          note: `${KIND_LABEL[kind]}${ROLE_LABEL[e.role]}`,
          paidAt: transferredAt,
          isShared: (accOwner.get(e.accountId) ?? null) == null,
          source: source === 'TEXT' ? 'TEXT' : 'MANUAL',
        },
      });
      linkedIds.push(t.id);
    }

    // ---- 信用卡帳單：沖該期（全額→PAID、部分→PARTIAL、溢繳要確認）----
    let statement: Awaited<ReturnType<typeof bumpStatement>> | null = null;
    if (kind === 'CARD_PAYMENT') {
      const s = await pickStatement(tx, familyId, to!.id, str(input.cardStatementId));
      if (s) {
        statement = await bumpStatement(tx, s.id, amount, now);
        if (statement.overpaid > 0 && input.confirmOverpay !== true) {
          throw new TransferRuleError('overpay_needs_confirm', `本期應繳 ${statement.newBalance}，這次會溢繳 ${statement.overpaid}`, 409, {
            cardStatementId: s.id,
            newBalance: statement.newBalance,
            paidBefore: r2(statement.paidAmount - amount),
            overpaid: statement.overpaid,
          });
        }
      }
    }

    // ---- 負債剩餘本金 ----
    const eff = liabilityEffect(kind, amount);
    const liabilityId = eff ? (eff.side === 'to' ? to!.id : from!.id) : null;
    if (eff && liabilityId) await applyLiability(tx, liabilityId, eff.current, eff.principalToo);

    const tr = await tx.transfer.create({
      data: {
        familyId,
        memberId,
        kind,
        fromAccountId: from?.type === 'ACCOUNT' ? from.id : null,
        fromLiabilityId: from?.type === 'LIABILITY' ? from.id : null,
        toAccountId: to?.type === 'ACCOUNT' ? to.id : null,
        toCreditCardId: to?.type === 'CARD' ? to.id : null,
        toLiabilityId: to?.type === 'LIABILITY' ? to.id : null,
        cardStatementId: statement?.id ?? null,
        amount,
        fee: fee > 0 ? fee : null,
        interest: interest > 0 ? interest : null,
        note: str(input.note),
        transferredAt,
        source,
        linkedTransactionIds: linkedIds,
      },
    });

    // ---- 還款紀錄（還貸款、收回借款）：本金／利息／手續費拆開記 ----
    if ((kind === 'LOAN_REPAY' || kind === 'COLLECT') && liabilityId) {
      await tx.liabilityPayment.create({
        data: {
          liabilityId,
          paidAt: transferredAt,
          total: r2(amount + interest + fee),
          principalPart: amount,
          interestPart: interest,
          feePart: fee,
          transactionId: linkedIds[0] ?? null,
          transferId: tr.id,
        },
      });
    }

    return { transfer: tr, statement, linkedTransactionIds: linkedIds, liabilityId };
  });
}

/** 撤銷：只有建立者能按；不刪轉帳，標 undoneAt，並把餘額、帳單、負債、連帶收支全部還原。 */
export async function undoTransfer(familyId: string, memberId: string, id: string, scope: AccessScope, now: Date = new Date()) {
  const tr = await prisma.transfer.findFirst({ where: { id, familyId } });
  if (!tr || !scope.transferView(tr).visible) throw new AccessError(404, 'not_found', 'transfer not found');
  if (tr.memberId !== memberId) throw new TransferRuleError('not_creator', 'only the member who created this transfer can undo it', 403);
  if (tr.undoneAt) throw new TransferRuleError('already_undone', 'transfer already undone', 409);

  return prisma.$transaction(async (tx) => {
    const r = await tx.transfer.updateMany({ where: { id, undoneAt: null }, data: { undoneAt: now, undoneByMemberId: memberId } });
    if (r.count === 0) throw new TransferRuleError('already_undone', 'transfer already undone', 409);
    if (tr.linkedTransactionIds.length) {
      await tx.transaction.deleteMany({ where: { familyId, id: { in: tr.linkedTransactionIds } } });
    }
    let statement: Awaited<ReturnType<typeof bumpStatement>> | null = null;
    if (tr.cardStatementId) statement = await bumpStatement(tx, tr.cardStatementId, -n(tr.amount), now);
    const eff = liabilityEffect(tr.kind, n(tr.amount));
    const liabilityId = eff ? (eff.side === 'to' ? tr.toLiabilityId : tr.fromLiabilityId) : null;
    if (eff && liabilityId) {
      await tx.liability.update({
        where: { id: liabilityId },
        data: {
          currentPrincipal: { increment: -eff.current },
          ...(eff.principalToo ? { principal: { increment: -eff.current } } : {}),
        },
      });
    }
    await tx.liabilityPayment.updateMany({ where: { transferId: id, undoneAt: null }, data: { undoneAt: now } });
    return { id, undoneAt: now.toISOString(), statement };
  });
}

/** 對帳狀態（跟對帳單對上了沒）：看得到明細、而且是建立者或能動其中一端的人才能改。 */
export async function setReconcileStatus(familyId: string, memberId: string, id: string, status: unknown, scope: AccessScope) {
  if (status !== 'RECONCILED' && status !== 'UNRECONCILED') throw new TransferRuleError('invalid_shape', 'reconcileStatus must be RECONCILED or UNRECONCILED');
  const tr = await prisma.transfer.findFirst({ where: { id, familyId } });
  if (!tr || !scope.transferView(tr).visible) throw new AccessError(404, 'not_found', 'transfer not found');
  const can =
    tr.memberId === memberId ||
    (tr.fromAccountId && scope.canWriteAccount(tr.fromAccountId)) ||
    (tr.toAccountId && scope.canWriteAccount(tr.toAccountId)) ||
    (tr.fromLiabilityId && scope.canWriteLiability(tr.fromLiabilityId)) ||
    (tr.toLiabilityId && scope.canWriteLiability(tr.toLiabilityId)) ||
    (tr.toCreditCardId && scope.canWriteCard(tr.toCreditCardId));
  if (!can) throw new AccessError(403, 'not_owner', 'cannot change reconcile status of this transfer');
  const updated = await prisma.transfer.update({ where: { id }, data: { reconcileStatus: status as ReconcileStatus } });
  return { id: updated.id, reconcileStatus: updated.reconcileStatus };
}

const listInclude = {
  fromAccount: { select: { name: true } },
  toAccount: { select: { name: true } },
  toCreditCard: { select: { name: true } },
  fromLiability: { select: { name: true } },
  toLiability: { select: { name: true } },
  member: { select: { displayName: true } },
} as const;

type ListRow = Prisma.TransferGetPayload<{ include: typeof listInclude }>;

function describe(t: ListRow, scope: AccessScope, memberId: string) {
  const v = scope.transferView(t);
  const fromName = t.fromAccount?.name ?? t.fromLiability?.name ?? '';
  const toName = t.toAccount?.name ?? t.toCreditCard?.name ?? t.toLiability?.name ?? '';
  return {
    id: t.id,
    kind: t.kind,
    kindLabel: KIND_LABEL[t.kind],
    amount: n(t.amount),
    fee: t.fee == null ? null : n(t.fee),
    interest: t.interest == null ? null : n(t.interest),
    fromName: v.maskFrom ? HIDDEN_ACCOUNT_NAME : fromName,
    toName: v.maskTo ? HIDDEN_ACCOUNT_NAME : toName,
    note: t.note,
    memberName: t.member.displayName,
    transferredAt: t.transferredAt.toISOString(),
    source: t.source,
    reconcileStatus: t.reconcileStatus,
    undone: !!t.undoneAt,
    undoneAt: t.undoneAt?.toISOString() ?? null,
    canUndo: !t.undoneAt && t.memberId === memberId,
  };
}

function monthRange(month: string): { start: Date; end: Date } {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(`${month}-01T00:00:00+08:00`);
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  return { start, end: new Date(`${nextY}-${String(nextM).padStart(2, '0')}-01T00:00:00+08:00`) };
}

/** 月轉帳列表（新到舊）：至少一端看得到明細才列；看不到的那端名稱遮掉。已撤銷的也列（標 undone）。 */
export async function getMonthlyTransfers(familyId: string, month: string, scope: AccessScope) {
  const { start, end } = monthRange(month);
  const rows = await prisma.transfer.findMany({
    where: { familyId, transferredAt: { gte: start, lt: end } },
    include: listInclude,
    orderBy: { transferredAt: 'desc' },
  });
  return rows.filter((t) => scope.transferView(t).visible).map((t) => describe(t, scope, scope.memberId));
}

export async function getTransferView(familyId: string, id: string, scope: AccessScope) {
  const t = await prisma.transfer.findFirst({ where: { id, familyId }, include: listInclude });
  if (!t || !scope.transferView(t).visible) throw new AccessError(404, 'not_found', 'transfer not found');
  return describe(t, scope, scope.memberId);
}
