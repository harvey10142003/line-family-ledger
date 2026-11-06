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
import type { Prisma, ReconcileStatus, TransferKind, TransferSide, TransferSource } from '@prisma/client';
import { prisma } from '../prisma';
import { AccessError, type AccessScope } from '../lib/access';
import {
  checkShape,
  checkSplit,
  CONFIRM_WINDOW_MS,
  isPrepaidAfterClosing,
  isTransferKind,
  liabilityEffect,
  linkedEntries,
  LINKED_CATEGORY,
  money,
  statementStatus,
  TEXT_UNDO_WINDOW_MS,
  TransferRuleError,
  type Endpoint,
  type LinkedEntry,
} from '../lib/transfer-rules';
import { taipeiNoon, ymdTaipei } from '../lib/time-tw';
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
  confirmOverpay?: unknown; // 繳卡費超過本期應繳（溢繳），或找不到可沖的帳單（預繳，no_statement_needs_confirm）時，要明確確認才收
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

/**
 * 某張卡的「預繳」：已生效、沒撤銷、還沒沖到任何一期帳單，而且付款日在最近一期結帳日之後（規則 A，isPrepaidAfterClosing）的繳卡費加總。
 * 不另開欄位：沖到帳單時把那筆轉帳的 cardStatementId 填上即可（card-statement.ts），撤銷照舊（沒沖帳單＝沒東西要還原）。
 * 結帳日當天或以前付、沒沖帳單的那幾筆＝已被銀行帳單的本期應繳計入，cardStatementId 一樣留空，只是不算預繳。
 */
export async function cardPrepaid(db: Tx | typeof prisma, familyId: string, cardId: string): Promise<number> {
  const [latest, rows] = await Promise.all([
    db.cardStatement.findFirst({ where: { familyId, cardId }, orderBy: { statementDate: 'desc' }, select: { statementDate: true } }),
    db.transfer.findMany({
      where: { familyId, kind: 'CARD_PAYMENT', toCreditCardId: cardId, cardStatementId: null, undoneAt: null, confirmStatus: 'CONFIRMED' },
      select: { amount: true, transferredAt: true },
    }),
  ]);
  return r2(rows.filter((t) => isPrepaidAfterClosing(t.transferredAt, latest?.statementDate)).reduce((sum, t) => sum + n(t.amount), 0));
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

export type CreateTransferOptions = {
  /**
   * D18（文字轉帳）：來源或目的是「別人的個人帳戶／卡／負債」時不直接動，先記成待對方確認（PENDING），
   * 對方在 LINE 按確認才生效。沒開這個選項（LIFF 手動）＝舊規則：別人的帳戶不能當來源（403）、可以當目的。
   */
  counterpartConfirm?: boolean;
};

type Effects = {
  statement: Awaited<ReturnType<typeof bumpStatement>> | null;
  linkedIds: string[];
  liabilityId: string | null;
};

/**
 * 轉帳真的「動錢」的部分：連帶收支（利息、手續費）、沖信用卡帳單、負債剩餘本金。
 * 建立（已生效）與對方確認（D18）共用這一段，規則只有一份。
 */
async function applyEffects(
  tx: Tx,
  p: {
    familyId: string;
    memberId: string;
    kind: TransferKind;
    from: Endpoint;
    to: Endpoint;
    amount: number;
    interest: number;
    fee: number;
    transferredAt: Date;
    source: TransferSource;
    cardStatementId: string | null;
    confirmOverpay: boolean;
    now: Date;
  },
): Promise<Effects> {
  const { familyId, kind, from, to, amount } = p;
  const linked = linkedEntries(kind, from, to, { interest: p.interest, fee: p.fee });
  const accOwner = new Map<string, string | null>();
  for (const e of [from, to]) if (e.type === 'ACCOUNT') accOwner.set(e.id, e.ownerMemberId);
  const linkedIds: string[] = [];
  for (const e of linked) {
    const t = await tx.transaction.create({
      data: {
        familyId,
        memberId: p.memberId,
        categoryId: await categoryFor(tx, familyId, e.role),
        accountId: e.accountId,
        amount: e.amount,
        note: `${KIND_LABEL[kind]}${ROLE_LABEL[e.role]}`,
        paidAt: p.transferredAt,
        isShared: (accOwner.get(e.accountId) ?? null) == null,
        source: p.source === 'TEXT' ? 'TEXT' : 'MANUAL',
      },
    });
    linkedIds.push(t.id);
  }

  let statement: Effects['statement'] = null;
  if (kind === 'CARD_PAYMENT') {
    const s = await pickStatement(tx, familyId, to.id, p.cardStatementId);
    if (!s) {
      // 沒有可沖的帳單（卡還沒有帳單，或最近一期已繳清又再繳）：錢不能憑空消失——
      // 確認後記成這張卡的「預繳」（cardStatementId 留空），淨資產算成資產；之後建立新帳單時，結帳日之後付的才自動抵扣（規則 A，card-statement.ts）。
      if (!p.confirmOverpay) {
        const latest = await tx.cardStatement.findFirst({ where: { familyId, cardId: to.id }, orderBy: { statementDate: 'desc' }, select: { id: true, statementDate: true } });
        // 規則 A：付款日在最近一期結帳日當天或以前 → 已算進那期帳單的應繳，記下來但不當預繳（不會再抵扣）
        const countedInStatement = !isPrepaidAfterClosing(p.transferredAt, latest?.statementDate);
        throw new TransferRuleError(
          'no_statement_needs_confirm',
          countedInStatement
            ? '付款日在最近一期結帳日當天或以前，視為已算進那期帳單的應繳，不會再抵扣'
            : latest
              ? '這張卡最近一期帳單已繳清，這筆會記成預繳'
              : '這張卡還沒有帳單，這筆會記成預繳',
          409,
          {
            reason: latest ? 'all_paid' : 'no_statement',
            latestStatementId: latest?.id ?? null,
            latestStatementDate: latest ? ymdTaipei(latest.statementDate) : null,
            countedInStatement,
            prepaidBefore: await cardPrepaid(tx, familyId, to.id),
            amount,
          },
        );
      }
    } else {
      statement = await bumpStatement(tx, s.id, amount, p.now);
      if (statement.overpaid > 0 && !p.confirmOverpay) {
        throw new TransferRuleError('overpay_needs_confirm', `本期應繳 ${statement.newBalance}，這次會溢繳 ${statement.overpaid}`, 409, {
          cardStatementId: s.id,
          newBalance: statement.newBalance,
          paidBefore: r2(statement.paidAmount - amount),
          overpaid: statement.overpaid,
        });
      }
    }
  }

  const eff = liabilityEffect(kind, amount);
  const liabilityId = eff ? (eff.side === 'to' ? to.id : from.id) : null;
  if (eff && liabilityId) await applyLiability(tx, liabilityId, eff.current, eff.principalToo);
  return { statement, linkedIds, liabilityId };
}

async function recordLiabilityPayment(
  tx: Tx,
  kind: TransferKind,
  liabilityId: string | null,
  transferId: string,
  p: { transferredAt: Date; amount: number; interest: number; fee: number; linkedIds: string[] },
) {
  if ((kind === 'LOAN_REPAY' || kind === 'COLLECT') && liabilityId) {
    await tx.liabilityPayment.create({
      data: {
        liabilityId,
        paidAt: p.transferredAt,
        total: r2(p.amount + p.interest + p.fee),
        principalPart: p.amount,
        interestPart: p.interest,
        feePart: p.fee,
        transactionId: p.linkedIds[0] ?? null,
        transferId,
      },
    });
  }
}

/** D18：這筆轉帳有沒有動到「別人」的個人帳戶／卡／負債；有的話是誰、哪一端。兩端都是別人的 → 不收。 */
function counterpartOf(
  scope: AccessScope,
  memberId: string,
  ends: { from: { accountId: string | null; liabilityId: string | null }; to: { accountId: string | null; creditCardId: string | null; liabilityId: string | null } },
): { memberId: string; side: TransferSide } | null {
  const owner = (e: { accountId?: string | null; creditCardId?: string | null; liabilityId?: string | null }) =>
    (e.accountId ? scope.account(e.accountId) : e.creditCardId ? scope.card(e.creditCardId) : e.liabilityId ? scope.liability(e.liabilityId) : undefined)?.ownerMemberId ?? null;
  const fo = owner(ends.from);
  const tOwner = owner(ends.to);
  const fromOther = fo && fo !== memberId ? fo : null;
  const toOther = tOwner && tOwner !== memberId ? tOwner : null;
  if (fromOther && toOther) throw new TransferRuleError('two_counterparts', '兩端都是別人的個人帳戶，請由本人記這筆', 403);
  if (fromOther) return { memberId: fromOther, side: 'FROM' };
  if (toOther) return { memberId: toOther, side: 'TO' };
  return null;
}

export async function createTransfer(
  familyId: string,
  memberId: string,
  input: CreateTransferInput,
  scope: AccessScope,
  now: Date = new Date(),
  opts: CreateTransferOptions = {},
) {
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

  // ---- D18：文字轉帳動到別人的個人帳戶 → 待對方確認（那一端只要看得到；自己這端照一般規則）----
  const counterpart = opts.counterpartConfirm
    ? counterpartOf(scope, memberId, {
        from: { accountId: fromAccountId, liabilityId: fromLiabilityId },
        to: { accountId: toAccountId, creditCardId: toCreditCardId, liabilityId: toLiabilityId },
      })
    : null;

  return prisma.$transaction(async (tx) => {
    // ---- 權限：先檢查（看不到的回 404，不透露存在；不能動的回 403）----
    const theirs = (side: TransferSide) => counterpart?.side === side;
    if (fromAccountId) {
      if (theirs('FROM')) scope.assertAccountTargetable(fromAccountId);
      else scope.assertAccountWritable(fromAccountId);
    }
    if (fromLiabilityId) {
      if (theirs('FROM')) scope.assertLiabilityTargetable(fromLiabilityId);
      else scope.assertLiabilityWritable(fromLiabilityId);
    }
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
    // 連帶收支要記在帳戶上：那個帳戶也必須能改（D10：不能在對方的個人帳戶上記支出）——
    // 待確認的轉帳要等對方按確認才記，記在對方帳戶上的那筆由對方的確認授權。
    for (const e of linked) {
      const onTheirs = !!counterpart && ((counterpart.side === 'FROM' && e.accountId === fromAccountId) || (counterpart.side === 'TO' && e.accountId === toAccountId));
      if (!onTheirs) scope.assertAccountWritable(e.accountId);
    }

    const base = {
      familyId,
      memberId,
      kind,
      fromAccountId: from?.type === 'ACCOUNT' ? from.id : null,
      fromLiabilityId: from?.type === 'LIABILITY' ? from.id : null,
      toAccountId: to?.type === 'ACCOUNT' ? to.id : null,
      toCreditCardId: to?.type === 'CARD' ? to.id : null,
      toLiabilityId: to?.type === 'LIABILITY' ? to.id : null,
      amount,
      fee: fee > 0 ? fee : null,
      interest: interest > 0 ? interest : null,
      note: str(input.note),
      transferredAt,
      source,
      createdAt: now, // 24 小時撤銷窗口、待確認期限都以這個時間起算
    };

    if (counterpart) {
      // 待確認：什麼都不動（餘額、帳單、負債、連帶收支都等對方確認）；繳卡費沖哪一期也等確認時再挑
      const tr = await tx.transfer.create({
        data: {
          ...base,
          cardStatementId: str(input.cardStatementId),
          confirmStatus: 'PENDING',
          counterpartMemberId: counterpart.memberId,
          counterpartSide: counterpart.side,
          confirmDeadline: new Date(now.getTime() + CONFIRM_WINDOW_MS),
        },
      });
      return { transfer: tr, statement: null, linkedTransactionIds: [] as string[], liabilityId: null as string | null, pending: true };
    }

    const effects = await applyEffects(tx, {
      familyId,
      memberId,
      kind,
      from: from!,
      to: to!,
      amount,
      interest,
      fee,
      transferredAt,
      source,
      cardStatementId: str(input.cardStatementId),
      confirmOverpay: input.confirmOverpay === true,
      now,
    });
    const tr = await tx.transfer.create({ data: { ...base, cardStatementId: effects.statement?.id ?? null, linkedTransactionIds: effects.linkedIds } });
    await recordLiabilityPayment(tx, kind, effects.liabilityId, tr.id, { transferredAt, amount, interest, fee, linkedIds: effects.linkedIds });
    return { transfer: tr, statement: effects.statement, linkedTransactionIds: effects.linkedIds, liabilityId: effects.liabilityId, pending: false };
  });
}

async function endpointsOf(
  tx: Tx,
  familyId: string,
  tr: { fromAccountId: string | null; fromLiabilityId: string | null; toAccountId: string | null; toCreditCardId: string | null; toLiabilityId: string | null },
) {
  const from = tr.fromAccountId ? await loadAccount(tx, familyId, tr.fromAccountId) : tr.fromLiabilityId ? await loadLiability(tx, familyId, tr.fromLiabilityId) : null;
  let to: Endpoint | null = null;
  if (tr.toAccountId) to = await loadAccount(tx, familyId, tr.toAccountId);
  else if (tr.toCreditCardId) to = { type: 'CARD', id: tr.toCreditCardId };
  else if (tr.toLiabilityId) to = await loadLiability(tx, familyId, tr.toLiabilityId);
  if (!from || !to) throw new TransferRuleError('invalid_shape', 'transfer endpoints missing');
  return { from, to };
}

/** D18：被動到個人帳戶的那位按「確認」→ 才真的動錢（同一般建立：連帶收支、沖帳單、負債本金）。 */
export async function confirmTransfer(familyId: string, memberId: string, id: string, now: Date = new Date()) {
  const tr = await prisma.transfer.findFirst({ where: { id, familyId } });
  if (!tr) throw new AccessError(404, 'not_found', 'transfer not found');
  if (tr.counterpartMemberId !== memberId) throw new TransferRuleError('not_counterpart', 'only the member whose account is involved can confirm', 403);
  if (tr.undoneAt) throw new TransferRuleError('already_undone', '這筆已經被撤銷了', 409);
  if (tr.confirmStatus !== 'PENDING' && tr.confirmStatus !== 'ONE_SIDED') {
    throw new TransferRuleError('not_pending', tr.confirmStatus === 'CONFIRMED' ? '這筆已經確認過了' : '這筆已經拒絕了', 409);
  }
  return prisma.$transaction(async (tx) => {
    const r = await tx.transfer.updateMany({
      where: { id, undoneAt: null, confirmStatus: { in: ['PENDING', 'ONE_SIDED'] } },
      data: { confirmStatus: 'CONFIRMED', confirmedAt: now },
    });
    if (r.count === 0) throw new TransferRuleError('not_pending', '這筆已經處理過了', 409);
    const { from, to } = await endpointsOf(tx, familyId, tr);
    const amount = n(tr.amount);
    const interest = n(tr.interest);
    const fee = n(tr.fee);
    const effects = await applyEffects(tx, {
      familyId,
      memberId: tr.memberId,
      kind: tr.kind,
      from,
      to,
      amount,
      interest,
      fee,
      transferredAt: tr.transferredAt,
      source: tr.source,
      cardStatementId: tr.cardStatementId,
      confirmOverpay: true, // 對方看過金額才按確認
      now,
    });
    const updated = await tx.transfer.update({ where: { id }, data: { cardStatementId: effects.statement?.id ?? null, linkedTransactionIds: effects.linkedIds } });
    await recordLiabilityPayment(tx, tr.kind, effects.liabilityId, id, { transferredAt: tr.transferredAt, amount, interest, fee, linkedIds: effects.linkedIds });
    return { transfer: updated, statement: effects.statement };
  });
}

/** D18：對方按「拒絕」→ 這筆不生效（紀錄留著）。ONE_SIDED 已算進建立者那一端的也一起不算。 */
export async function rejectTransfer(familyId: string, memberId: string, id: string, now: Date = new Date()) {
  const tr = await prisma.transfer.findFirst({ where: { id, familyId } });
  if (!tr) throw new AccessError(404, 'not_found', 'transfer not found');
  if (tr.counterpartMemberId !== memberId) throw new TransferRuleError('not_counterpart', 'only the member whose account is involved can reject', 403);
  const r = await prisma.transfer.updateMany({
    where: { id, undoneAt: null, confirmStatus: { in: ['PENDING', 'ONE_SIDED'] } },
    data: { confirmStatus: 'REJECTED', rejectedAt: now },
  });
  if (r.count === 0) throw new TransferRuleError('not_pending', '這筆已經處理過了', 409);
  return prisma.transfer.findUniqueOrThrow({ where: { id } });
}

/**
 * D18：建立 24 小時後對方還沒回 → ONE_SIDED：只算建立者這一端（例如 Shark 的收入側），標「待確認」；
 * 對方之後仍可確認（兩端都生效）或拒絕。回傳這次轉成 ONE_SIDED 的轉帳（給排程通知建立者）。
 */
export async function expirePendingTransfers(now: Date = new Date()) {
  const due = await prisma.transfer.findMany({
    where: { confirmStatus: 'PENDING', undoneAt: null, confirmDeadline: { lte: now } },
    select: { id: true },
  });
  const ids: string[] = [];
  for (const d of due) {
    const r = await prisma.transfer.updateMany({ where: { id: d.id, confirmStatus: 'PENDING', undoneAt: null }, data: { confirmStatus: 'ONE_SIDED' } });
    if (r.count) ids.push(d.id);
  }
  if (ids.length === 0) return [];
  return prisma.transfer.findMany({ where: { id: { in: ids } }, include: { ...listInclude, member: { select: { displayName: true, lineUserId: true } } } });
}

/**
 * 撤銷：只有建立者能按；不刪轉帳，標 undoneAt，並把餘額、帳單、負債、連帶收支全部還原。
 * opts.withinMs：LINE 確認卡上的一鍵撤銷只在建立後 24 小時內有效（超過要到 LIFF，3.10.3）。
 * 還沒生效的（待對方確認、對方拒絕、只算一邊）沒有帳單／負債／連帶收支要還原，只標 undoneAt。
 */
export async function undoTransfer(familyId: string, memberId: string, id: string, scope: AccessScope, now: Date = new Date(), opts: { withinMs?: number } = {}) {
  const tr = await prisma.transfer.findFirst({ where: { id, familyId } });
  if (!tr || !scope.transferView(tr).visible) throw new AccessError(404, 'not_found', 'transfer not found');
  if (tr.memberId !== memberId) throw new TransferRuleError('not_creator', 'only the member who created this transfer can undo it', 403);
  if (tr.undoneAt) throw new TransferRuleError('already_undone', 'transfer already undone', 409);
  if (opts.withinMs != null && now.getTime() - tr.createdAt.getTime() > opts.withinMs) {
    throw new TransferRuleError('undo_window_passed', '超過 24 小時，請到記帳簿撤銷', 403);
  }

  return prisma.$transaction(async (tx) => {
    const r = await tx.transfer.updateMany({ where: { id, undoneAt: null }, data: { undoneAt: now, undoneByMemberId: memberId } });
    if (r.count === 0) throw new TransferRuleError('already_undone', 'transfer already undone', 409);
    // 確認狀態以鎖住後的那一列為準（同時有人按確認時不會漏還原）
    const cur = await tx.transfer.findUniqueOrThrow({ where: { id } });
    if (cur.confirmStatus !== 'CONFIRMED') return { id, undoneAt: now.toISOString(), statement: null };
    if (cur.linkedTransactionIds.length) {
      await tx.transaction.deleteMany({ where: { familyId, id: { in: cur.linkedTransactionIds } } });
    }
    let statement: Awaited<ReturnType<typeof bumpStatement>> | null = null;
    if (cur.cardStatementId) statement = await bumpStatement(tx, cur.cardStatementId, -n(cur.amount), now);
    const eff = liabilityEffect(cur.kind, n(cur.amount));
    const liabilityId = eff ? (eff.side === 'to' ? cur.toLiabilityId : cur.fromLiabilityId) : null;
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

/**
 * 確認卡上的「改帳戶」「改金額」：用新的內容另建一筆（同一個出口 createTransfer），成功後才撤銷舊的。
 * 只有建立者、24 小時內可以改（同一鍵撤銷）。新建失敗 → 舊的維持不動。
 */
export async function replaceTransfer(
  familyId: string,
  memberId: string,
  id: string,
  changes: { amount?: number; fromAccountId?: string; toAccountId?: string; toCreditCardId?: string; confirmOverpay?: boolean },
  scope: AccessScope,
  now: Date = new Date(),
) {
  const tr = await prisma.transfer.findFirst({ where: { id, familyId } });
  if (!tr || !scope.transferView(tr).visible) throw new AccessError(404, 'not_found', 'transfer not found');
  if (tr.memberId !== memberId) throw new TransferRuleError('not_creator', 'only the member who created this transfer can change it', 403);
  if (tr.undoneAt) throw new TransferRuleError('already_undone', 'transfer already undone', 409);
  if (now.getTime() - tr.createdAt.getTime() > TEXT_UNDO_WINDOW_MS) throw new TransferRuleError('undo_window_passed', '超過 24 小時，請到記帳簿修改', 403);
  const newTo = changes.toAccountId || changes.toCreditCardId;
  let kind: TransferKind = tr.kind;
  if (changes.toCreditCardId && kind === 'ACCOUNT') kind = 'CARD_PAYMENT';
  if (changes.toAccountId && kind === 'CARD_PAYMENT') kind = 'ACCOUNT';
  const input: CreateTransferInput = {
    kind,
    fromAccountId: changes.fromAccountId ?? tr.fromAccountId,
    fromLiabilityId: changes.fromAccountId ? null : tr.fromLiabilityId,
    toAccountId: newTo ? (changes.toAccountId ?? null) : tr.toAccountId,
    toCreditCardId: newTo ? (changes.toCreditCardId ?? null) : tr.toCreditCardId,
    toLiabilityId: newTo ? null : tr.toLiabilityId,
    amount: changes.amount ?? n(tr.amount),
    interest: tr.interest == null ? undefined : n(tr.interest),
    fee: tr.fee == null ? undefined : n(tr.fee),
    note: tr.note,
    transferredAt: ymdTaipei(tr.transferredAt),
    source: tr.source,
    confirmOverpay: changes.confirmOverpay === true,
  };
  if ((kind === 'SPOUSE' || kind === 'ACCOUNT') && input.fromAccountId && input.toAccountId) {
    // 改了帳戶後兩端不一定還是兩位成員的個人帳戶：先換成合適的種類再交給組合檢查
    const fo = scope.account(String(input.fromAccountId))?.ownerMemberId ?? null;
    const tOwner = scope.account(String(input.toAccountId))?.ownerMemberId ?? null;
    input.kind = fo && tOwner && fo !== tOwner ? 'SPOUSE' : 'ACCOUNT';
  }
  // 先撤銷舊的（帳單已繳、負債本金先還原，新的那筆才會沖到同一期、本金檢查才正確），再用新內容建；
  // 新的建不起來（例如超過剩餘本金）→ 用舊內容原樣補回一筆，並把錯誤丟回去。
  const original: CreateTransferInput = {
    kind: tr.kind,
    fromAccountId: tr.fromAccountId,
    fromLiabilityId: tr.fromLiabilityId,
    toAccountId: tr.toAccountId,
    toCreditCardId: tr.toCreditCardId,
    toLiabilityId: tr.toLiabilityId,
    cardStatementId: tr.cardStatementId,
    amount: n(tr.amount),
    interest: input.interest,
    fee: input.fee,
    note: tr.note,
    transferredAt: input.transferredAt,
    source: tr.source,
    confirmOverpay: true,
  };
  if (tr.kind === 'CARD_PAYMENT' && input.kind === 'CARD_PAYMENT' && input.toCreditCardId === tr.toCreditCardId) {
    input.cardStatementId = tr.cardStatementId;
    // 原本就是已確認的預繳（沒沖到帳單）→ 同一張卡改金額時不用再問一次預繳
    if (!tr.cardStatementId && tr.confirmStatus === 'CONFIRMED') input.confirmOverpay = true;
  }
  const counterpartConfirm = tr.source === 'TEXT';
  await undoTransfer(familyId, memberId, id, scope, now);
  try {
    return await createTransfer(familyId, memberId, input, scope, now, { counterpartConfirm });
  } catch (err) {
    await createTransfer(familyId, memberId, original, scope, now, { counterpartConfirm }).catch(() => undefined);
    throw err;
  }
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

function describe(t: ListRow, scope: AccessScope, memberId: string, names: Map<string, string> = new Map()) {
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
    // D18：待對方確認
    confirmStatus: t.confirmStatus,
    counterpartName: t.counterpartMemberId ? names.get(t.counterpartMemberId) ?? null : null,
    confirmDeadline: t.confirmDeadline?.toISOString() ?? null,
    canConfirm: !t.undoneAt && t.counterpartMemberId === memberId && (t.confirmStatus === 'PENDING' || t.confirmStatus === 'ONE_SIDED'),
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
  const names = await memberNames(familyId);
  return rows.filter((t) => scope.transferView(t).visible).map((t) => describe(t, scope, scope.memberId, names));
}

export async function getTransferView(familyId: string, id: string, scope: AccessScope) {
  const t = await prisma.transfer.findFirst({ where: { id, familyId }, include: listInclude });
  if (!t || !scope.transferView(t).visible) throw new AccessError(404, 'not_found', 'transfer not found');
  return describe(t, scope, scope.memberId, await memberNames(familyId));
}

async function memberNames(familyId: string): Promise<Map<string, string>> {
  const ms = await prisma.familyMember.findMany({ where: { familyId }, select: { id: true, displayName: true } });
  return new Map(ms.map((m) => [m.id, m.displayName]));
}
