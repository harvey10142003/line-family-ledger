// 負債與借出（財務中樞 P1-3，規格 2.4）：CRUD、利率變動、攤還表、還款紀錄。
// 攤還數字全部由 lib/amortization.ts 算；權限全部問 AccessScope（D2／D10 規則與帳戶相同）。
// 還款「動錢」的部分不在這裡：一律走 services/transfer.ts 的轉帳引擎（LOAN_REPAY／COLLECT），
// 這樣本金、利息、手續費的拆法與撤銷只有一個出口。
import type { Liability, LiabilityDirection, LiabilityKind, LiabilityRateChange, RepaymentMethod, Visibility } from '@prisma/client';
import { prisma } from '../prisma';
import type { AccessLevel, AccessScope } from '../lib/access';
import { AccessError } from '../lib/access';
import {
  buildSchedule,
  expectedBalanceAt,
  nextPeriod,
  signedLiabilityAmount,
  suggestSplit,
  type LoanTerms,
  type ScheduleRow,
} from '../lib/amortization';
import { taipeiNoon, ymdTaipei } from '../lib/time-tw';

const DIRECTIONS: LiabilityDirection[] = ['BORROWED', 'LENT'];
const KINDS: LiabilityKind[] = ['MORTGAGE', 'CAR', 'PERSONAL', 'FAMILY', 'OTHER'];
const METHODS: RepaymentMethod[] = ['EQUAL_PAYMENT', 'EQUAL_PRINCIPAL', 'INTEREST_ONLY', 'FREE'];

type WithRates = Liability & { rateChanges: LiabilityRateChange[] };

const num = (d: unknown): number => Number(d ?? 0);

/** 資料庫的一列 → 攤還條件。FREE 或缺利率／期數／首期日 → null（沒有攤還表）。 */
export function termsOf(l: WithRates): LoanTerms | null {
  if (l.method === 'FREE' || l.annualRate == null || !l.termMonths || !l.startDate) return null;
  return {
    principal: num(l.principal),
    annualRatePct: l.rateChanges.length ? rateBase(l) : num(l.annualRate),
    termMonths: l.termMonths,
    method: l.method,
    gracePeriodMonths: l.gracePeriodMonths,
    firstPaymentDate: ymdTaipei(l.startDate),
    paymentDay: l.paymentDay,
    rateChanges: l.rateChanges.map((c) => ({ effectiveDate: ymdTaipei(c.effectiveDate), annualRatePct: num(c.annualRate) })),
  };
}

// 有利率歷程時，起始利率＝最早一筆歷程（第一次改利率時會把原利率補記成第一筆）
function rateBase(l: WithRates): number {
  const first = [...l.rateChanges].sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime())[0];
  return num(first.annualRate);
}

export type LiabilityView = {
  id: string;
  name: string;
  direction: LiabilityDirection;
  currentPrincipal: number;
  signedAmount: number; // 借出＝正（資產）、借入＝負（負債）
  ownerMemberId: string | null;
  ownerName: string | null;
  visibility: Visibility;
  access: AccessLevel;
  canEdit: boolean;
  isArchived: boolean;
  // 以下只有看得到明細（DETAIL）才有；只看總額的對方個人負債只回上面那些
  kind?: LiabilityKind;
  lender?: string | null;
  principal?: number;
  annualRate?: number | null;
  termMonths?: number | null;
  startDate?: string | null;
  paymentDay?: number | null;
  method?: RepaymentMethod;
  gracePeriodMonths?: number;
  payFromAccountId?: string | null;
  note?: string | null;
  expectedPrincipal?: number | null; // 依攤還表今天「應該」剩多少；跟 currentPrincipal 差超過 1 元時前端提示
  nextPayment?: ScheduleRow | null;
  payoffDate?: string | null;
};

function view(l: WithRates & { owner: { displayName: string } | null }, scope: AccessScope, today: string): LiabilityView {
  const access = scope.liabilityLevel(l.id);
  const current = num(l.currentPrincipal);
  const base: LiabilityView = {
    id: l.id,
    name: l.name,
    direction: l.direction,
    currentPrincipal: current,
    signedAmount: signedLiabilityAmount(l.direction, current),
    ownerMemberId: l.ownerMemberId,
    ownerName: l.owner?.displayName ?? null,
    visibility: l.visibility,
    access,
    canEdit: scope.canWriteLiability(l.id),
    isArchived: l.isArchived,
  };
  if (access !== 'DETAIL') return base;
  const terms = termsOf(l);
  const schedule = terms ? buildSchedule(terms) : [];
  return {
    ...base,
    kind: l.kind,
    lender: l.lender,
    principal: num(l.principal),
    annualRate: l.annualRate == null ? null : num(l.annualRate),
    termMonths: l.termMonths,
    startDate: l.startDate ? ymdTaipei(l.startDate) : null,
    paymentDay: l.paymentDay,
    method: l.method,
    gracePeriodMonths: l.gracePeriodMonths,
    payFromAccountId: l.payFromAccountId,
    note: l.note,
    expectedPrincipal: terms ? expectedBalanceAt(schedule, terms.principal, today) : null,
    nextPayment: terms ? nextPeriod(schedule, today) : null,
    payoffDate: schedule.length ? schedule[schedule.length - 1].date : null,
  };
}

/** 清單＋合計。看不到的（對方 OWNER_ONLY）不列也不算；只看總額的算進合計。 */
export async function getLiabilities(familyId: string, includeArchived: boolean, scope: AccessScope, now: Date = new Date()) {
  const rows = await prisma.liability.findMany({
    where: { familyId, ...(includeArchived ? {} : { isArchived: false }) },
    include: { rateChanges: true, owner: { select: { displayName: true } } },
    orderBy: [{ direction: 'asc' }, { createdAt: 'asc' }],
  });
  const today = ymdTaipei(now);
  const items = rows.filter((l) => scope.liabilityLevel(l.id) !== 'NONE').map((l) => view(l, scope, today));
  const active = items.filter((i) => !i.isArchived);
  const borrowed = active.filter((i) => i.direction === 'BORROWED').reduce((s, i) => s + i.currentPrincipal, 0);
  const lent = active.filter((i) => i.direction === 'LENT').reduce((s, i) => s + i.currentPrincipal, 0);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { items, totals: { borrowed: r2(borrowed), lent: r2(lent), net: r2(lent - borrowed) } };
}

async function getWithRates(familyId: string, id: string) {
  const l = await prisma.liability.findFirst({ where: { id, familyId }, include: { rateChanges: true } });
  if (!l) throw new AccessError(404, 'not_found', 'liability not found');
  return l;
}

/** 看得到明細才能看攤還表、還款紀錄（只看總額的回 404，不透露細節）。 */
async function getDetailVisible(familyId: string, id: string, scope: AccessScope) {
  const l = await getWithRates(familyId, id);
  if (scope.liabilityLevel(l.id) !== 'DETAIL') throw new AccessError(404, 'not_found', 'liability not found');
  return l;
}

export type LiabilityInput = {
  name?: unknown;
  direction?: unknown;
  kind?: unknown;
  lender?: unknown;
  principal?: unknown;
  currentPrincipal?: unknown;
  annualRate?: unknown;
  termMonths?: unknown;
  startDate?: unknown;
  paymentDay?: unknown;
  method?: unknown;
  gracePeriodMonths?: unknown;
  payFromAccountId?: unknown;
  note?: unknown;
  isArchived?: unknown;
  ownerMemberId?: unknown;
  visibility?: unknown;
};

function optNumber(v: unknown, field: string, min: number, max: number): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`invalid ${field}`);
  return n;
}

function optInt(v: unknown, field: string, min: number, max: number): number | null | undefined {
  const n = optNumber(v, field, min, max);
  if (n == null) return n;
  if (!Number.isInteger(n)) throw new Error(`invalid ${field}`);
  return n;
}

function pick<T extends string>(v: unknown, allowed: readonly T[], field: string): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new Error(`invalid ${field}`);
  return v as T;
}

/** 檢查 payFromAccountId：要是同家庭、而且自己能動的帳戶（D10，自動扣款會從這個帳戶出錢）。 */
async function checkPayFrom(familyId: string, v: unknown, scope: AccessScope): Promise<string | null | undefined> {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new Error('invalid payFromAccountId');
  const acc = await prisma.account.findFirst({ where: { id: v, familyId }, select: { id: true } });
  if (!acc) throw new Error('invalid payFromAccountId');
  scope.assertAccountWritable(v);
  return v;
}

/** 有攤還方式就必須有利率、期數、首期日，而且攤還表算得出來。 */
function assertTermsValid(l: { method: RepaymentMethod; annualRate: unknown; termMonths: number | null; startDate: Date | null; gracePeriodMonths: number; principal: unknown; paymentDay: number | null }) {
  if (l.method === 'FREE') return;
  if (l.annualRate == null || !l.termMonths || !l.startDate) throw new Error('annualRate, termMonths, startDate required for this method');
  buildSchedule({
    principal: num(l.principal),
    annualRatePct: num(l.annualRate),
    termMonths: l.termMonths,
    method: l.method,
    gracePeriodMonths: l.gracePeriodMonths,
    firstPaymentDate: ymdTaipei(l.startDate),
    paymentDay: l.paymentDay,
  });
}

export async function createLiability(familyId: string, input: LiabilityInput, scope: AccessScope) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new Error('name required');
  const principal = optNumber(input.principal, 'principal', 0, 1e12);
  if (principal == null) throw new Error('principal required');
  const own = scope.resolveOwnership(null, { ownerMemberId: input.ownerMemberId, visibility: input.visibility });
  const startDate = input.startDate == null || input.startDate === '' ? null : taipeiNoon(input.startDate);
  if (startDate === undefined) throw new Error('invalid startDate');
  const data = {
    familyId,
    name,
    direction: pick(input.direction, DIRECTIONS, 'direction') ?? 'BORROWED',
    kind: pick(input.kind, KINDS, 'kind') ?? 'OTHER',
    lender: typeof input.lender === 'string' && input.lender.trim() ? input.lender.trim() : null,
    principal,
    currentPrincipal: optNumber(input.currentPrincipal, 'currentPrincipal', 0, 1e12) ?? principal,
    annualRate: optNumber(input.annualRate, 'annualRate', 0, 100) ?? null,
    termMonths: optInt(input.termMonths, 'termMonths', 1, 1200) ?? null,
    startDate,
    paymentDay: optInt(input.paymentDay, 'paymentDay', 1, 31) ?? null,
    method: pick(input.method, METHODS, 'method') ?? 'FREE',
    gracePeriodMonths: optInt(input.gracePeriodMonths, 'gracePeriodMonths', 0, 1200) ?? 0,
    payFromAccountId: (await checkPayFrom(familyId, input.payFromAccountId, scope)) ?? null,
    note: typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null,
    ...own,
  } as const;
  assertTermsValid(data);
  return prisma.liability.create({ data });
}

export async function updateLiability(familyId: string, id: string, input: LiabilityInput, scope: AccessScope) {
  const l = await getWithRates(familyId, id);
  scope.assertLiabilityWritable(l.id);
  const ownership =
    input.ownerMemberId !== undefined || input.visibility !== undefined
      ? scope.resolveOwnership(l, { ownerMemberId: input.ownerMemberId, visibility: input.visibility })
      : null;
  const startDate = input.startDate === undefined ? undefined : input.startDate === null || input.startDate === '' ? null : taipeiNoon(input.startDate) ?? 'bad';
  if (startDate === 'bad') throw new Error('invalid startDate');
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new Error('name required');
    data.name = name;
  }
  const set = (k: string, v: unknown) => {
    if (v !== undefined) data[k] = v;
  };
  set('direction', pick(input.direction, DIRECTIONS, 'direction'));
  set('kind', pick(input.kind, KINDS, 'kind'));
  if (input.lender !== undefined) data.lender = typeof input.lender === 'string' && input.lender.trim() ? input.lender.trim() : null;
  const principal = optNumber(input.principal, 'principal', 0, 1e12);
  if (principal === null) throw new Error('principal required');
  set('principal', principal);
  const current = optNumber(input.currentPrincipal, 'currentPrincipal', 0, 1e12);
  if (current === null) throw new Error('currentPrincipal required');
  set('currentPrincipal', current); // 手動對帳值（以銀行對帳單為準）
  set('annualRate', optNumber(input.annualRate, 'annualRate', 0, 100));
  set('termMonths', optInt(input.termMonths, 'termMonths', 1, 1200));
  set('startDate', startDate);
  set('paymentDay', optInt(input.paymentDay, 'paymentDay', 1, 31));
  set('method', pick(input.method, METHODS, 'method'));
  const grace = optInt(input.gracePeriodMonths, 'gracePeriodMonths', 0, 1200);
  set('gracePeriodMonths', grace === null ? 0 : grace);
  set('payFromAccountId', await checkPayFrom(familyId, input.payFromAccountId, scope));
  if (input.note !== undefined) data.note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;
  if (typeof input.isArchived === 'boolean') data.isArchived = input.isArchived;
  if (ownership) Object.assign(data, ownership);
  assertTermsValid({ ...l, ...(data as Partial<Liability>) });
  return prisma.liability.update({ where: { id: l.id }, data });
}

/**
 * 利率變動（機動利率）。第一次改時先把原本的利率補記成第一筆歷程（生效日＝首期日，沒有就用建立日），
 * 這樣攤還表永遠能從歷程重算。annualRate 欄位維持「今天有效的利率」。
 */
export async function addRateChange(familyId: string, id: string, input: { effectiveDate?: unknown; annualRate?: unknown }, scope: AccessScope, now: Date = new Date()) {
  const l = await getWithRates(familyId, id);
  scope.assertLiabilityWritable(l.id);
  const eff = taipeiNoon(input.effectiveDate);
  if (!eff) throw new Error('invalid effectiveDate');
  const rate = optNumber(input.annualRate, 'annualRate', 0, 100);
  if (rate == null) throw new Error('annualRate required');
  return prisma.$transaction(async (tx) => {
    if (l.rateChanges.length === 0 && l.annualRate != null) {
      const baseDate = l.startDate ?? l.createdAt;
      if (ymdTaipei(baseDate) < ymdTaipei(eff)) {
        await tx.liabilityRateChange.create({ data: { liabilityId: l.id, effectiveDate: baseDate, annualRate: l.annualRate } });
      }
    }
    const sameDay = await tx.liabilityRateChange.findFirst({ where: { liabilityId: l.id, effectiveDate: eff } });
    if (sameDay) await tx.liabilityRateChange.update({ where: { id: sameDay.id }, data: { annualRate: rate } });
    else await tx.liabilityRateChange.create({ data: { liabilityId: l.id, effectiveDate: eff, annualRate: rate } });
    const all = await tx.liabilityRateChange.findMany({ where: { liabilityId: l.id }, orderBy: { effectiveDate: 'asc' } });
    const todayYmd = ymdTaipei(now);
    const effective = all.filter((c) => ymdTaipei(c.effectiveDate) <= todayYmd).pop();
    if (effective) await tx.liability.update({ where: { id: l.id }, data: { annualRate: effective.annualRate } });
    return all.map((c) => ({ effectiveDate: ymdTaipei(c.effectiveDate), annualRate: num(c.annualRate) }));
  });
}

export async function getSchedule(familyId: string, id: string, scope: AccessScope) {
  const l = await getDetailVisible(familyId, id, scope);
  const terms = termsOf(l);
  return {
    method: l.method,
    rateChanges: l.rateChanges
      .map((c) => ({ effectiveDate: ymdTaipei(c.effectiveDate), annualRate: num(c.annualRate) }))
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)),
    rows: terms ? buildSchedule(terms) : [],
  };
}

export async function getPayments(familyId: string, id: string, scope: AccessScope) {
  const l = await getDetailVisible(familyId, id, scope);
  const rows = await prisma.liabilityPayment.findMany({ where: { liabilityId: l.id }, orderBy: { paidAt: 'desc' } });
  return rows.map((p) => ({
    id: p.id,
    paidAt: p.paidAt.toISOString(),
    total: num(p.total),
    principalPart: num(p.principalPart),
    interestPart: num(p.interestPart),
    feePart: num(p.feePart),
    transferId: p.transferId,
    undone: !!p.undoneAt,
  }));
}

/** 只知道總額時建議本金／利息怎麼拆（用剩餘本金與該日有效利率）。給 LIFF 先填好讓人確認。 */
export async function suggestPaymentSplit(familyId: string, id: string, total: number, date: string, scope: AccessScope) {
  const l = await getDetailVisible(familyId, id, scope);
  if (!(total > 0)) throw new Error('total must be positive');
  const terms = termsOf(l);
  const rate = terms
    ? (terms.rateChanges ?? []).filter((c) => c.effectiveDate <= date).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)).pop()?.annualRatePct ?? terms.annualRatePct
    : num(l.annualRate);
  return { annualRate: rate, ...suggestSplit(num(l.currentPrincipal), rate, total) };
}
