import { prisma } from '../prisma';
import { logger } from '../logger';
import type { RecurringFreq } from '@prisma/client';

function taipeiNow(): { y: number; m: number; d: number; dow: number; ymd: string } {
  const t = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    dow: t.getUTCDay(),
    ymd: `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`,
  };
}
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function clampDay(n: unknown, fallback: number, max = 31): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 0) return fallback;
  return Math.min(v, max);
}

// 列出固定收支（含分類/帳戶/卡名稱）
export async function getRecurringRules(familyId: string) {
  const rules = await prisma.recurringRule.findMany({ where: { familyId }, orderBy: { createdAt: 'desc' } });
  if (rules.length === 0) return [];
  const [cats, accounts, cards] = await Promise.all([
    prisma.category.findMany({ where: { familyId } }),
    prisma.account.findMany({ where: { familyId } }),
    prisma.creditCard.findMany({ where: { familyId } }),
  ]);
  const catMap = new Map(cats.map((c) => [c.id, c]));
  const accMap = new Map(accounts.map((a) => [a.id, a]));
  const cardMap = new Map(cards.map((c) => [c.id, c]));

  return rules.map((r) => ({
    id: r.id,
    amount: Number(r.amount),
    note: r.note,
    isShared: r.isShared,
    frequency: r.frequency,
    dayOfMonth: r.dayOfMonth,
    dayOfWeek: r.dayOfWeek,
    isActive: r.isActive,
    categoryId: r.categoryId,
    categoryName: catMap.get(r.categoryId)?.name ?? '（已刪分類）',
    categoryIcon: catMap.get(r.categoryId)?.icon ?? null,
    type: catMap.get(r.categoryId)?.type ?? 'EXPENSE',
    accountId: r.accountId,
    creditCardId: r.creditCardId,
    payName: r.creditCardId ? cardMap.get(r.creditCardId)?.name ?? null : r.accountId ? accMap.get(r.accountId)?.name ?? null : null,
    lastPostedAt: r.lastPostedAt?.toISOString() ?? null,
  }));
}

export async function createRecurringRule(params: {
  familyId: string;
  memberId: string;
  categoryId: string;
  amount: number;
  note?: string | null;
  isShared?: boolean;
  frequency?: RecurringFreq;
  dayOfMonth?: number;
  dayOfWeek?: number;
  accountId?: string | null;
  creditCardId?: string | null;
}) {
  const cat = await prisma.category.findFirst({ where: { id: params.categoryId, familyId: params.familyId } });
  if (!cat) throw new Error('invalid categoryId');
  return prisma.recurringRule.create({
    data: {
      familyId: params.familyId,
      memberId: params.memberId,
      categoryId: params.categoryId,
      amount: Math.round(params.amount * 100) / 100,
      note: params.note?.trim() || null,
      isShared: params.isShared ?? true,
      frequency: params.frequency ?? 'MONTHLY',
      dayOfMonth: clampDay(params.dayOfMonth, 1, 31),
      dayOfWeek: clampDay(params.dayOfWeek, 1, 6),
      accountId: params.creditCardId ? null : params.accountId ?? null,
      creditCardId: params.creditCardId ?? null,
    },
  });
}

export async function updateRecurringRule(params: {
  familyId: string;
  id: string;
  categoryId?: string;
  amount?: number;
  note?: string | null;
  isShared?: boolean;
  frequency?: RecurringFreq;
  dayOfMonth?: number;
  dayOfWeek?: number;
  accountId?: string | null;
  creditCardId?: string | null;
  isActive?: boolean;
}) {
  const rule = await prisma.recurringRule.findFirst({ where: { id: params.id, familyId: params.familyId } });
  if (!rule) throw new Error('rule not found');
  const data: Record<string, unknown> = {};
  if (params.categoryId !== undefined) {
    const cat = await prisma.category.findFirst({ where: { id: params.categoryId, familyId: params.familyId } });
    if (!cat) throw new Error('invalid categoryId');
    data.categoryId = params.categoryId;
  }
  if (params.amount !== undefined && params.amount > 0) data.amount = Math.round(params.amount * 100) / 100;
  if (params.note !== undefined) data.note = params.note?.trim() || null;
  if (params.isShared !== undefined) data.isShared = params.isShared;
  if (params.frequency !== undefined) data.frequency = params.frequency;
  if (params.dayOfMonth !== undefined) data.dayOfMonth = clampDay(params.dayOfMonth, rule.dayOfMonth, 31);
  if (params.dayOfWeek !== undefined) data.dayOfWeek = clampDay(params.dayOfWeek, rule.dayOfWeek, 6);
  if (params.isActive !== undefined) data.isActive = params.isActive;
  if (params.creditCardId !== undefined) {
    data.creditCardId = params.creditCardId || null;
    if (params.creditCardId) data.accountId = null;
  }
  if (params.accountId !== undefined) {
    data.accountId = params.accountId || null;
    if (params.accountId) data.creditCardId = null;
  }
  return prisma.recurringRule.update({ where: { id: params.id }, data });
}

export async function deleteRecurringRule(familyId: string, id: string) {
  const rule = await prisma.recurringRule.findFirst({ where: { id, familyId } });
  if (!rule) throw new Error('rule not found');
  await prisma.recurringRule.delete({ where: { id } });
}

// 每日跑：把今天到期且尚未產生的固定收支寫成交易
export async function postDueRecurring(): Promise<{ posted: number }> {
  const now = taipeiNow();
  const rules = await prisma.recurringRule.findMany({ where: { isActive: true } });

  let posted = 0;
  for (const r of rules) {
    // 是否今天到期
    let due = false;
    if (r.frequency === 'MONTHLY') {
      const target = Math.min(r.dayOfMonth, daysInMonth(now.y, now.m));
      due = now.d === target;
    } else {
      due = now.dow === r.dayOfWeek;
    }
    if (!due) continue;

    // 防同日重複
    if (r.lastPostedAt) {
      const lp = new Date(r.lastPostedAt.getTime() + 8 * 60 * 60 * 1000);
      const lpYmd = `${lp.getUTCFullYear()}-${String(lp.getUTCMonth() + 1).padStart(2, '0')}-${String(lp.getUTCDate()).padStart(2, '0')}`;
      if (lpYmd === now.ymd) continue;
    }

    // 分類還在才產生
    const cat = await prisma.category.findFirst({ where: { id: r.categoryId, familyId: r.familyId } });
    if (!cat) continue;

    await prisma.transaction.create({
      data: {
        familyId: r.familyId,
        memberId: r.memberId,
        categoryId: r.categoryId,
        amount: r.amount,
        note: r.note,
        paidAt: new Date(),
        isShared: r.isShared,
        source: 'RECURRING',
        accountId: r.accountId,
        creditCardId: r.creditCardId,
      },
    });
    await prisma.recurringRule.update({ where: { id: r.id }, data: { lastPostedAt: new Date() } });
    posted++;
  }

  logger.info({ posted, checked: rules.length }, 'recurring posted');
  return { posted };
}
