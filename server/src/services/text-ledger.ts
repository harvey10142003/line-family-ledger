// 文字記帳／一句話建轉帳的資料庫這一側（P1-5、P1-6）：載入比對候選、執行計畫、學別名。
// 解析與比對規則在 lib/ledger-plan.ts、lib/ledger-resolve.ts（純函式）；轉帳一律走 services/transfer.ts。
import type { AccountType } from '@prisma/client';
import { prisma } from '../prisma';
import type { AccessScope } from '../lib/access';
import { nextAliases, type MatchCandidate, type MemberRef } from '../lib/account-match';
import type { ResolvedTransfer, ResolvedTx, EndpointRef } from '../lib/ledger-resolve';
import { noonOf } from '../lib/date-text';
import { recordTransaction } from './transaction';
import { createTransfer, type CreateTransferInput } from './transfer';
import { suggestPaymentSplit } from './liability';
import { ensureDefaultAccounts } from './account';

/** 說話者看得到的帳戶、卡、負債（D2：別人 OWNER_ONLY 的不放；writable＝D10 能不能動）。 */
export async function loadMatchCandidates(familyId: string, scope: AccessScope): Promise<MatchCandidate[]> {
  await ensureDefaultAccounts(familyId);
  const [accs, cards, lias] = await Promise.all([
    prisma.account.findMany({ where: { familyId, isArchived: false }, orderBy: { sortOrder: 'asc' } }),
    prisma.creditCard.findMany({ where: { familyId, isArchived: false }, orderBy: { sortOrder: 'asc' } }),
    prisma.liability.findMany({ where: { familyId, isArchived: false }, orderBy: { createdAt: 'asc' } }),
  ]);
  const out: MatchCandidate[] = [];
  for (const a of accs) {
    if (scope.accountLevel(a.id) === 'NONE') continue;
    out.push({
      kind: 'ACCOUNT',
      id: a.id,
      name: a.name,
      institution: a.institution,
      aliases: a.aliases,
      last4: a.accountLast4,
      ownerMemberId: a.ownerMemberId,
      writable: scope.canWriteAccount(a.id),
      isDefault: a.isDefault,
      accountType: a.type,
      sortOrder: a.sortOrder,
    });
  }
  for (const c of cards) {
    if (scope.cardLevel(c.id) === 'NONE') continue;
    out.push({
      kind: 'CARD',
      id: c.id,
      name: c.name,
      institution: c.issuer,
      aliases: c.aliases,
      last4: c.cardLast4,
      ownerMemberId: c.ownerMemberId,
      writable: scope.canWriteCard(c.id),
      sortOrder: c.sortOrder,
    });
  }
  for (const l of lias) {
    if (scope.liabilityLevel(l.id) === 'NONE') continue;
    out.push({
      kind: 'LIABILITY',
      id: l.id,
      name: l.name,
      aliases: l.aliases,
      ownerMemberId: l.ownerMemberId,
      writable: scope.canWriteLiability(l.id),
      direction: l.direction,
      liabilityKind: l.kind,
      lender: l.lender,
      payFromAccountId: l.payFromAccountId,
    });
  }
  return out;
}

export async function loadMembers(familyId: string): Promise<MemberRef[]> {
  return prisma.familyMember.findMany({ where: { familyId }, select: { id: true, displayName: true }, orderBy: { joinedAt: 'asc' } });
}

/** 「領現金」沒講從哪裡領：這位成員近 180 天最常提款的帳戶。 */
export async function frequentWithdrawFrom(familyId: string, memberId: string, now: Date = new Date()): Promise<string | null> {
  const rows = await prisma.transfer.groupBy({
    by: ['fromAccountId'],
    where: { familyId, memberId, kind: 'CASH_WITHDRAW', undoneAt: null, transferredAt: { gte: new Date(now.getTime() - 180 * 86400000) } },
    _count: { _all: true },
    orderBy: { _count: { fromAccountId: 'desc' } },
    take: 1,
  });
  return rows[0]?.fromAccountId ?? null;
}

/**
 * 使用者在 Quick Reply 點了候選 → 把那句叫法記成別名（下次同一句不再問）。
 * 只記在說話者能動的項目上（別人的個人帳戶不改它的資料，D10）。
 */
export async function learnAlias(familyId: string, cand: { kind: 'ACCOUNT' | 'CARD' | 'LIABILITY'; id: string }, raw: string, scope: AccessScope): Promise<boolean> {
  if (cand.kind === 'ACCOUNT') {
    if (!scope.canWriteAccount(cand.id)) return false;
    const a = await prisma.account.findFirst({ where: { id: cand.id, familyId } });
    const next = a ? nextAliases(a.aliases, raw, a.name) : null;
    if (!next) return false;
    await prisma.account.update({ where: { id: a!.id }, data: { aliases: next } });
    return true;
  }
  if (cand.kind === 'CARD') {
    if (!scope.canWriteCard(cand.id)) return false;
    const c = await prisma.creditCard.findFirst({ where: { id: cand.id, familyId } });
    const next = c ? nextAliases(c.aliases, raw, c.name) : null;
    if (!next) return false;
    await prisma.creditCard.update({ where: { id: c!.id }, data: { aliases: next } });
    return true;
  }
  if (!scope.canWriteLiability(cand.id)) return false;
  const l = await prisma.liability.findFirst({ where: { id: cand.id, familyId } });
  const next = l ? nextAliases(l.aliases, raw, l.name) : null;
  if (!next) return false;
  await prisma.liability.update({ where: { id: l!.id }, data: { aliases: next } });
  return true;
}

/** 「要建立『將來定存』嗎？」→ 建一個共同帳戶（類型依位置：定存、現金或銀行），沿用 pending-account 的建法。 */
export async function createAccountFromText(familyId: string, name: string, type: AccountType) {
  const existing = await prisma.account.findFirst({ where: { familyId, name } });
  if (existing) return existing;
  const max = await prisma.account.aggregate({ where: { familyId }, _max: { sortOrder: true } });
  return prisma.account.create({ data: { familyId, name, type, sortOrder: (max._max.sortOrder ?? 0) + 1 } });
}

export function transferInputOf(step: ResolvedTransfer, extra: { amount?: number; interest?: number; confirmOverpay?: boolean } = {}): CreateTransferInput {
  const end = (e: EndpointRef, side: 'from' | 'to') => {
    if (e.type === 'ACCOUNT') return side === 'from' ? { fromAccountId: e.id } : { toAccountId: e.id };
    if (e.type === 'CARD') return { toCreditCardId: e.id };
    if (e.type === 'LIABILITY') return side === 'from' ? { fromLiabilityId: e.id } : { toLiabilityId: e.id };
    return { newLiability: { name: e.name, lender: e.name } };
  };
  const it = step.item;
  return {
    kind: step.kind,
    ...end(step.from, 'from'),
    ...end(step.to, 'to'),
    amount: extra.amount ?? it.amount,
    interest: (extra.interest ?? it.interest) || undefined,
    fee: it.fee || undefined,
    total: it.total ?? undefined,
    note: it.note || null,
    transferredAt: it.date.ok ? it.date.ymd : undefined,
    source: 'TEXT',
    confirmOverpay: extra.confirmOverpay === true,
  };
}

export type ExecutedTx = Awaited<ReturnType<typeof recordTransaction>> & { step: ResolvedTx };
export type ExecutedTransfer =
  | { ok: true; step: ResolvedTransfer; result: Awaited<ReturnType<typeof createTransfer>>; split?: { principal: number; interest: number } }
  | { ok: false; step: ResolvedTransfer; error: unknown };

/** 寫入一筆收支（日期、歸屬人、公司、外幣都已經由計畫決定）。 */
export async function executeTx(familyId: string, speakerId: string, step: ResolvedTx): Promise<ExecutedTx> {
  const it = step.item;
  const tx = await recordTransaction({
    familyId,
    memberId: it.ownerMemberId ?? speakerId,
    recordedByMemberId: it.ownerMemberId ? speakerId : null,
    parsed: { amount: it.amount, categoryName: it.categoryName, note: it.note, type: it.txType },
    source: 'TEXT',
    paidAt: it.date.ok ? noonOf(it.date.ymd) : undefined,
    accountId: step.accountId,
    creditCardId: step.creditCardId,
    bookTo: it.bookTo,
    originalCurrency: it.originalCurrency,
    originalAmount: it.originalAmount,
    amountEstimated: it.amountEstimated,
    fx: it.fx ?? null,
  });
  return Object.assign(tx, { step });
}

/** 建一筆文字轉帳：只說總額的還房貸先用攤還表拆本金／利息；動到別人的個人帳戶 → 待對方確認（D18）。 */
export async function executeTransfer(
  familyId: string,
  speakerId: string,
  step: ResolvedTransfer,
  scope: AccessScope,
  now: Date = new Date(),
  extra: { confirmOverpay?: boolean } = {},
): Promise<ExecutedTransfer> {
  try {
    let split: { principal: number; interest: number } | undefined;
    let input = transferInputOf(step, extra);
    if (step.item.needsSplit && step.kind === 'LOAN_REPAY' && step.to.type === 'LIABILITY') {
      const total = step.item.amount;
      try {
        const s = await suggestPaymentSplit(familyId, step.to.id, total, step.item.date.ymd, scope);
        if (s.interest > 0 && s.excess === 0) {
          split = { principal: s.principal, interest: s.interest };
          input = { ...transferInputOf(step, { ...extra, amount: s.principal, interest: s.interest }), total };
        }
      } catch {
        // 沒有利率（親友借款）或看不到明細 → 全額當本金
      }
    }
    const result = await createTransfer(familyId, speakerId, input, scope, now, { counterpartConfirm: true });
    return { ok: true, step, result, split };
  } catch (error) {
    return { ok: false, step, error };
  }
}
