import { prisma } from '../prisma';
import { ymdTaipei } from '../lib/time-tw';
import type { Visibility } from '@prisma/client';
import type { AccessLevel, AccessScope } from '../lib/access';

// 台北「今天」的 y/m/d
function taipeiToday(now: Date = new Date()): { y: number; m: number; d: number } {
  const t = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// 以 +08:00 建立某年月日的起始 Date
function taipeiDate(y: number, m: number, day: number): Date {
  const d = Math.min(day, daysInMonth(y, m));
  return new Date(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+08:00`);
}

// 本期帳單起始日（最近一次結算日，含當天之後算新週期）
function cycleStart(statementDay: number): Date {
  const { y, m, d } = taipeiToday();
  if (d >= statementDay) return taipeiDate(y, m, statementDay);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return taipeiDate(py, pm, statementDay);
}

// 下次繳費日（>= 今天的最近 dueDay），回傳台北日期 YYYY-MM-DD。
// taipeiDate() 是台北 00:00＝UTC 前一天 16:00，不可用 toISOString().slice(0, 10)，會早一天。
export function nextDueDate(dueDay: number, now: Date = new Date()): string {
  return ymdTaipei(nextDueDateAt(dueDay, now));
}

function nextDueDateAt(dueDay: number, now: Date): Date {
  const { y, m, d } = taipeiToday(now);
  if (d <= dueDay) return taipeiDate(y, m, dueDay);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return taipeiDate(ny, nm, dueDay);
}

export type CreditCardStatus = {
  id: string;
  name: string;
  icon: string | null;
  creditLimit: number;
  statementDay: number;
  dueDay: number;
  cycleUsed: number; // 本期已用
  available: number; // 可用額度
  nextDueDate: string; // 下次繳費日 YYYY-MM-DD
  isArchived: boolean;
  sortOrder: number;
  // 財務中樞 P1-2：歸屬與可見範圍
  ownerMemberId: string | null;
  ownerName: string | null;
  visibility: Visibility;
  access: AccessLevel;
  canEdit: boolean;
};

// 依 scope：別人 OWNER_ONLY 的卡不列；只看總額的列出本期已用（本來就是總額）。
export async function getCreditCards(familyId: string, includeArchived: boolean, scope: AccessScope): Promise<CreditCardStatus[]> {
  const all = await prisma.creditCard.findMany({
    where: { familyId, ...(includeArchived ? {} : { isArchived: false }) },
    orderBy: { sortOrder: 'asc' },
    include: { owner: { select: { displayName: true } } },
  });
  const cards = all.filter((c) => scope.cardLevel(c.id) !== 'NONE');
  if (cards.length === 0) return [];

  const txs = await prisma.transaction.findMany({
    where: { familyId, creditCardId: { not: null } },
    select: { creditCardId: true, amount: true, paidAt: true, category: { select: { type: true } } },
  });

  return cards.map((c) => {
    const cs = cycleStart(c.statementDay);
    let cycleUsed = 0;
    for (const t of txs) {
      if (t.creditCardId !== c.id) continue;
      if (t.paidAt < cs) continue;
      const amt = Number(t.amount);
      cycleUsed += t.category.type === 'INCOME' ? -amt : amt; // 退刷減少已用
    }
    cycleUsed = Math.round(cycleUsed * 100) / 100;
    const limit = Number(c.creditLimit);
    return {
      id: c.id,
      name: c.name,
      icon: c.icon,
      creditLimit: limit,
      statementDay: c.statementDay,
      dueDay: c.dueDay,
      cycleUsed,
      available: Math.round((limit - cycleUsed) * 100) / 100,
      nextDueDate: nextDueDate(c.dueDay),
      isArchived: c.isArchived,
      sortOrder: c.sortOrder,
      ownerMemberId: c.ownerMemberId,
      ownerName: c.owner?.displayName ?? null,
      visibility: c.visibility,
      access: scope.cardLevel(c.id),
      canEdit: scope.canWriteCard(c.id),
    };
  });
}

function clampDay(n: unknown, fallback: number): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return fallback;
  return Math.min(v, 31);
}

export async function createCreditCard(params: {
  familyId: string;
  name: string;
  creditLimit?: number;
  statementDay?: number;
  dueDay?: number;
  icon?: string | null;
  // 歸屬：呼叫端先用 scope.resolveOwnership 正規化；不給＝共同（舊行為）
  ownerMemberId?: string | null;
  visibility?: Visibility;
}) {
  const max = await prisma.creditCard.aggregate({ where: { familyId: params.familyId }, _max: { sortOrder: true } });
  return prisma.creditCard.create({
    data: {
      familyId: params.familyId,
      name: params.name,
      creditLimit: params.creditLimit ?? 0,
      statementDay: clampDay(params.statementDay, 1),
      dueDay: clampDay(params.dueDay, 15),
      icon: params.icon ?? '💳',
      sortOrder: (max._max.sortOrder ?? 0) + 1,
      ...(params.ownerMemberId ? { ownerMemberId: params.ownerMemberId, visibility: params.visibility ?? 'FAMILY_TOTAL_ONLY' } : {}),
    },
  });
}

export async function updateCreditCard(
  params: {
    familyId: string;
    cardId: string;
    name?: string;
    creditLimit?: number;
    statementDay?: number;
    dueDay?: number;
    isArchived?: boolean;
    ownerMemberId?: unknown;
    visibility?: unknown;
  },
  scope: AccessScope,
) {
  const card = await prisma.creditCard.findFirst({ where: { id: params.cardId, familyId: params.familyId } });
  if (!card) throw new Error('credit card not found');
  scope.assertCardWritable(card.id); // D10
  const ownership =
    params.ownerMemberId !== undefined || params.visibility !== undefined
      ? scope.resolveOwnership(card, { ownerMemberId: params.ownerMemberId, visibility: params.visibility })
      : null;
  return prisma.creditCard.update({
    where: { id: params.cardId },
    data: {
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.creditLimit !== undefined ? { creditLimit: params.creditLimit } : {}),
      ...(params.statementDay !== undefined ? { statementDay: clampDay(params.statementDay, card.statementDay) } : {}),
      ...(params.dueDay !== undefined ? { dueDay: clampDay(params.dueDay, card.dueDay) } : {}),
      ...(params.isArchived !== undefined ? { isArchived: params.isArchived } : {}),
      ...(ownership ?? {}),
    },
  });
}

// 記帳時把付款名稱對應到信用卡（回 cardId 或 null）。只回說話者可以記進去的卡（共同或自己的，D10）。
export async function resolveCreditCardId(familyId: string, name: string | null | undefined, scope: AccessScope): Promise<string | null> {
  if (!name) return null;
  const hit = await prisma.creditCard.findFirst({ where: { familyId, name, isArchived: false } });
  return hit && scope.canWriteCard(hit.id) ? hit.id : null;
}
