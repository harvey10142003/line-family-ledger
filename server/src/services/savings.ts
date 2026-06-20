import { prisma } from '../prisma';

export async function getSavingsGoals(familyId: string, includeArchived = false) {
  const goals = await prisma.savingsGoal.findMany({
    where: { familyId, ...(includeArchived ? {} : { isArchived: false }) },
    orderBy: { sortOrder: 'asc' },
  });
  return goals.map((g) => {
    const target = Number(g.targetAmount);
    const saved = Number(g.savedAmount);
    return {
      id: g.id,
      name: g.name,
      icon: g.icon,
      targetAmount: target,
      savedAmount: saved,
      pct: target > 0 ? Math.min(Math.round((saved / target) * 100), 100) : 0,
      remaining: Math.max(0, Math.round((target - saved) * 100) / 100),
      targetDate: g.targetDate ? g.targetDate.toISOString().slice(0, 10) : null,
      isArchived: g.isArchived,
      sortOrder: g.sortOrder,
    };
  });
}

export async function createSavingsGoal(params: {
  familyId: string;
  name: string;
  targetAmount: number;
  savedAmount?: number;
  icon?: string | null;
  targetDate?: string | null;
}) {
  const max = await prisma.savingsGoal.aggregate({ where: { familyId: params.familyId }, _max: { sortOrder: true } });
  return prisma.savingsGoal.create({
    data: {
      familyId: params.familyId,
      name: params.name,
      targetAmount: Math.round(params.targetAmount * 100) / 100,
      savedAmount: params.savedAmount ? Math.round(params.savedAmount * 100) / 100 : 0,
      icon: params.icon ?? '🎯',
      targetDate: params.targetDate && /^\d{4}-\d{2}-\d{2}$/.test(params.targetDate) ? new Date(`${params.targetDate}T12:00:00+08:00`) : null,
      sortOrder: (max._max.sortOrder ?? 0) + 1,
    },
  });
}

export async function updateSavingsGoal(params: {
  familyId: string;
  id: string;
  name?: string;
  targetAmount?: number;
  targetDate?: string | null;
  isArchived?: boolean;
}) {
  const g = await prisma.savingsGoal.findFirst({ where: { id: params.id, familyId: params.familyId } });
  if (!g) throw new Error('goal not found');
  const data: Record<string, unknown> = {};
  if (params.name !== undefined) data.name = params.name;
  if (params.targetAmount !== undefined && params.targetAmount > 0) data.targetAmount = Math.round(params.targetAmount * 100) / 100;
  if (params.targetDate !== undefined) data.targetDate = params.targetDate && /^\d{4}-\d{2}-\d{2}$/.test(params.targetDate) ? new Date(`${params.targetDate}T12:00:00+08:00`) : null;
  if (params.isArchived !== undefined) data.isArchived = params.isArchived;
  return prisma.savingsGoal.update({ where: { id: params.id }, data });
}

// 存入(正)/取出(負)：調整 savedAmount，最低 0
export async function adjustSaved(familyId: string, id: string, delta: number) {
  const g = await prisma.savingsGoal.findFirst({ where: { id, familyId } });
  if (!g) throw new Error('goal not found');
  const next = Math.max(0, Math.round((Number(g.savedAmount) + delta) * 100) / 100);
  return prisma.savingsGoal.update({ where: { id }, data: { savedAmount: next } });
}

export async function deleteSavingsGoal(familyId: string, id: string) {
  const g = await prisma.savingsGoal.findFirst({ where: { id, familyId } });
  if (!g) throw new Error('goal not found');
  await prisma.savingsGoal.delete({ where: { id } });
}
