// 淨資產快照與「全貌」頁（財務中樞 P1-7）。計算規則在 lib/net-worth.ts；這裡負責「某個時間點」的各項數字與存取。
//
// 時間點（asOf）的算法：
// - 帳戶餘額＝期初＋asOf 以前的收支＋asOf 以前的轉帳（只算沒撤銷的；D18 依確認狀態只算生效的那幾端）
// - 負債剩餘本金＝目前剩餘本金 − asOf 之後已生效轉帳造成的變動（還款、借出、借入、收回）
// - 信用卡已出帳未繳＝asOf 以前最近一期帳單的「應繳 − 已繳」，已繳扣掉 asOf 之後才繳的那幾筆
// - 代墊公司費用＝asOf 以前 bookTo=BUSINESS、還沒歸墊（PENDING／CLAIMED）的加總
// 快照存下來之後就不再跟著舊資料變（要重算要手動按），所以歷史點不會跳。
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { AccessScope } from '../lib/access';
import { activeLegs, liabilityEffect } from '../lib/transfer-rules';
import { computeNetWorth, isMonth, monthEndTaipei, monthsBetween, previousMonthTaipei, type NetWorthResult, type NWInput } from '../lib/net-worth';
import { ymdTaipei } from '../lib/time-tw';
import { loadAccessScope } from './access';
import { getMonthlySummary } from './transaction';
import { getLiabilities } from './liability';
import { logger } from '../logger';

const n = (d: unknown) => Number(d ?? 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** 家庭在某時間點的原始數字（還沒依可見範圍過濾）。asOf=null＝現在。 */
async function rawAt(familyId: string, asOf: Date | null) {
  const before = asOf ? { lte: asOf } : undefined;
  const [accounts, txs, transfers, liabilities, cards, statements, receivables, members] = await Promise.all([
    prisma.account.findMany({ where: { familyId, isArchived: false, type: { not: 'CREDIT_CARD' } } }),
    prisma.transaction.findMany({
      where: { familyId, accountId: { not: null }, ...(before ? { paidAt: before } : {}) },
      select: { accountId: true, amount: true, category: { select: { type: true } } },
    }),
    prisma.transfer.findMany({ where: { familyId, undoneAt: null } }),
    prisma.liability.findMany({ where: { familyId, isArchived: false } }),
    prisma.creditCard.findMany({ where: { familyId, isArchived: false } }),
    prisma.cardStatement.findMany({ where: { familyId, ...(before ? { statementDate: before } : {}) }, orderBy: { statementDate: 'desc' } }),
    prisma.transaction.findMany({
      where: { familyId, bookTo: 'BUSINESS', reimburseStatus: { in: ['PENDING', 'CLAIMED'] }, ...(before ? { paidAt: before } : {}) },
      select: { amount: true, accountId: true, creditCardId: true, category: { select: { type: true } } },
    }),
    prisma.familyMember.findMany({ where: { familyId }, select: { id: true, displayName: true } }),
  ]);

  const delta = new Map<string, number>();
  const add = (id: string, v: number) => delta.set(id, (delta.get(id) ?? 0) + v);
  for (const t of txs) if (t.accountId) add(t.accountId, t.category.type === 'INCOME' ? n(t.amount) : -n(t.amount));
  const liaAfter = new Map<string, number>(); // asOf 之後的本金變動（要扣回去）
  const cardPaidAfter = new Map<string, number>(); // asOf 之後才繳、沖到某期帳單的金額
  for (const tr of transfers) {
    const legs = activeLegs(tr);
    const amt = n(tr.amount);
    const after = asOf ? tr.transferredAt.getTime() > asOf.getTime() : false;
    if (!after) {
      if (tr.fromAccountId && legs.from) add(tr.fromAccountId, -amt);
      if (tr.toAccountId && legs.to) add(tr.toAccountId, amt);
      continue;
    }
    if (tr.confirmStatus !== 'CONFIRMED') continue; // 只有生效的才動過負債本金、帳單
    const eff = liabilityEffect(tr.kind, amt);
    const lid = eff ? (eff.side === 'to' ? tr.toLiabilityId : tr.fromLiabilityId) : null;
    if (eff && lid) liaAfter.set(lid, (liaAfter.get(lid) ?? 0) + eff.current);
    if (tr.cardStatementId) cardPaidAfter.set(tr.cardStatementId, (cardPaidAfter.get(tr.cardStatementId) ?? 0) + amt);
  }

  const latestStmt = new Map<string, (typeof statements)[number]>();
  for (const s of statements) if (!latestStmt.has(s.cardId)) latestStmt.set(s.cardId, s);

  return {
    members,
    accounts: accounts
      .filter((a) => !asOf || a.createdAt.getTime() <= asOf.getTime() || delta.has(a.id))
      .map((a) => ({ a, balance: r2(n(a.openingBalance) + (delta.get(a.id) ?? 0)) })),
    liabilities: liabilities
      .filter((l) => !asOf || l.createdAt.getTime() <= asOf.getTime())
      .map((l) => ({ l, principal: r2(n(l.currentPrincipal) - (liaAfter.get(l.id) ?? 0)) })),
    cards: cards.map((c) => {
      const s = latestStmt.get(c.id);
      const unpaid = s ? r2(n(s.newBalance) - (n(s.paidAmount) - (cardPaidAfter.get(s.id) ?? 0))) : 0;
      return { c, unpaid };
    }),
    receivables,
  };
}

function inputFor(raw: Awaited<ReturnType<typeof rawAt>>, scope: AccessScope): NWInput {
  return {
    viewerId: scope.memberId,
    members: raw.members,
    accounts: raw.accounts.map(({ a, balance }) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      ownerMemberId: a.ownerMemberId,
      level: scope.accountLevel(a.id),
      business: a.purpose === 'BUSINESS',
      balance,
    })),
    liabilities: raw.liabilities.map(({ l, principal }) => ({
      id: l.id,
      name: l.name,
      direction: l.direction,
      kind: l.kind,
      ownerMemberId: l.ownerMemberId,
      level: scope.liabilityLevel(l.id),
      principal,
    })),
    cards: raw.cards.map(({ c, unpaid }) => ({ id: c.id, name: c.name, ownerMemberId: c.ownerMemberId, level: scope.cardLevel(c.id), unpaid })),
    receivables: raw.receivables.map((t) => {
      const owner = t.creditCardId ? scope.card(t.creditCardId)?.ownerMemberId ?? null : t.accountId ? scope.account(t.accountId)?.ownerMemberId ?? null : null;
      // 公司退款（INCOME）減少應收
      return { ownerMemberId: owner, level: scope.txLevel(t), amount: t.category.type === 'INCOME' ? -n(t.amount) : n(t.amount) };
    }),
  };
}

/** 某位成員看得到的淨資產（asOf=null＝現在）。 */
export async function computeForViewer(familyId: string, scope: AccessScope, asOf: Date | null = null): Promise<NetWorthResult> {
  return computeNetWorth(inputFor(await rawAt(familyId, asOf), scope));
}

/**
 * 存某個月的快照（每位成員各一份「他看得到的」）。force=false：已經存過的不動（歷史點不跳）；
 * force=true：手動重算，覆寫。回傳寫了幾份。
 */
export async function snapshotMonth(familyId: string, month: string, opts: { force?: boolean } = {}): Promise<number> {
  if (!isMonth(month)) throw new Error('month must be YYYY-MM');
  const asOf = monthEndTaipei(month);
  const raw = await rawAt(familyId, asOf);
  let written = 0;
  for (const m of raw.members) {
    const scope = await loadAccessScope(familyId, m.id);
    const nw = computeNetWorth(inputFor(raw, scope));
    const data = {
      assets: nw.assets,
      liabilities: nw.liabilities,
      netWorth: nw.netWorth,
      breakdown: { composition: nw.composition, byOwner: nw.byOwner, rows: nw.rows } as unknown as Prisma.InputJsonValue,
      asOf,
    };
    const key = { familyId_month_viewerMemberId: { familyId, month, viewerMemberId: m.id } };
    if (opts.force) {
      await prisma.netWorthSnapshot.upsert({ where: key, update: data, create: { familyId, month, viewerMemberId: m.id, ...data } });
      written++;
    } else {
      const exists = await prisma.netWorthSnapshot.findUnique({ where: key, select: { id: true } });
      if (exists) continue;
      try {
        await prisma.netWorthSnapshot.create({ data: { familyId, month, viewerMemberId: m.id, ...data } });
        written++;
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err; // 同時跑兩次：另一邊已寫
      }
    }
  }
  return written;
}

/** 每月 1 號 08:30（台北）：所有家庭存上個月的快照。 */
export async function runMonthlySnapshots(now: Date = new Date(), month: string = previousMonthTaipei(now)) {
  const families = await prisma.family.findMany({ select: { id: true } });
  let written = 0;
  for (const f of families) {
    try {
      written += await snapshotMonth(f.id, month);
    } catch (err) {
      logger.error({ err, familyId: f.id, month }, 'net worth snapshot failed');
    }
  }
  return { month, families: families.length, written };
}

/** 「全貌」頁：淨資產（現在）、走勢（快照＋本月即時）、資產負債組成、本月現金流、負債還清時間表、代墊公司費用。 */
export async function getOverview(familyId: string, scope: AccessScope, month: string, now: Date = new Date()) {
  const [live, snaps, summary, lia] = await Promise.all([
    computeForViewer(familyId, scope, null),
    prisma.netWorthSnapshot.findMany({ where: { familyId, viewerMemberId: scope.memberId }, orderBy: { month: 'desc' }, take: 24 }),
    getMonthlySummary(familyId, month, scope),
    getLiabilities(familyId, false, scope, now),
  ]);
  const nowMonth = ymdTaipei(now).slice(0, 7);
  const history = snaps
    .reverse()
    .filter((s) => s.month < nowMonth)
    .map((s) => {
      const b = s.breakdown as unknown as { byOwner?: { ownerId: string; name: string; netWorth: number }[] };
      return { month: s.month, netWorth: n(s.netWorth), assets: n(s.assets), liabilities: n(s.liabilities), byOwner: b.byOwner ?? [], live: false };
    });
  history.push({ month: nowMonth, netWorth: live.netWorth, assets: live.assets, liabilities: live.liabilities, byOwner: live.byOwner, live: true });

  const today = ymdTaipei(now);
  const payoff = lia.items
    .filter((l) => l.direction === 'BORROWED' && l.currentPrincipal > 0)
    .map((l) => ({
      id: l.id,
      name: l.name,
      ownerName: l.ownerName,
      access: l.access,
      currentPrincipal: l.currentPrincipal,
      // 只看總額的對方個人負債沒有攤還明細
      payoffDate: l.payoffDate ?? null,
      monthsLeft: l.payoffDate ? monthsBetween(today, l.payoffDate) : null,
      nextPayment: l.nextPayment ?? null,
      annualRate: l.annualRate ?? null,
    }))
    .sort((a, b) => (a.payoffDate ?? '9999').localeCompare(b.payoffDate ?? '9999'));

  const saved = r2(summary.totalIncome - summary.totalExpense);
  return {
    asOf: now.toISOString(),
    netWorth: live,
    history,
    cashflow: {
      month,
      income: summary.totalIncome,
      expense: summary.totalExpense,
      saved,
      savingsRate: summary.totalIncome > 0 ? Math.round((saved / summary.totalIncome) * 1000) / 10 : null,
    },
    payoff,
    receivable: live.composition.assets.find((a) => a.key === 'receivable')?.amount ?? 0,
  };
}
