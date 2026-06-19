import { prisma } from '../prisma';
import { getMonthlySummary } from './transaction';

// 取得家庭目前設定的預算（整體 + 各分類）
export async function getBudgets(familyId: string) {
  const rows = await prisma.budget.findMany({ where: { familyId } });
  const overall = rows.find((b) => b.categoryId === null);
  return {
    overall: overall ? Number(overall.amount) : null,
    byCategory: rows
      .filter((b) => b.categoryId !== null)
      .map((b) => ({ categoryId: b.categoryId as string, amount: Number(b.amount) })),
  };
}

// 設定（upsert）預算；amount <= 0 視為刪除。categoryId=null 表整體月預算。
export async function setBudget(familyId: string, categoryId: string | null, amount: number) {
  const existing = await prisma.budget.findFirst({ where: { familyId, categoryId } });

  if (amount <= 0) {
    if (existing) await prisma.budget.delete({ where: { id: existing.id } });
    return;
  }

  if (existing) {
    await prisma.budget.update({ where: { id: existing.id }, data: { amount } });
  } else {
    await prisma.budget.create({ data: { familyId, categoryId, amount } });
  }
}

// 台北當月 "YYYY-MM"
function currentTaipeiMonth(): string {
  const taipei = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return `${taipei.getUTCFullYear()}-${String(taipei.getUTCMonth() + 1).padStart(2, '0')}`;
}

// 記帳後檢查整體月預算，回傳要附加的提醒字串（未設定或未達 80% 回 null）
export async function getBudgetAlert(familyId: string): Promise<string | null> {
  const { overall } = await getBudgets(familyId);
  if (overall == null || overall <= 0) return null;

  const summary = await getMonthlySummary(familyId, currentTaipeiMonth());
  const pct = Math.round((summary.totalExpense / overall) * 100);
  if (pct >= 100) {
    return `⚠️ 本月已超出預算！已花 $${summary.totalExpense.toLocaleString('en-US')} / 預算 $${overall.toLocaleString('en-US')}（${pct}%）`;
  }
  if (pct >= 80) {
    return `🔔 本月預算已用 ${pct}%（$${summary.totalExpense.toLocaleString('en-US')} / $${overall.toLocaleString('en-US')}）`;
  }
  return null;
}

export type BudgetStatus = {
  month: string;
  overall: { budget: number; spent: number; pct: number } | null;
  byCategory: { categoryId: string; name: string; icon: string | null; budget: number; spent: number; pct: number }[];
};

// 預算使用狀況：把設定的預算對上當月支出
export async function getBudgetStatus(familyId: string, month: string): Promise<BudgetStatus> {
  const [{ overall, byCategory }, summary, cats] = await Promise.all([
    getBudgets(familyId),
    getMonthlySummary(familyId, month),
    prisma.category.findMany({ where: { familyId } }),
  ]);

  const catById = new Map(cats.map((c) => [c.id, c]));
  // 當月各分類支出（用名稱對回，summary.byCategory 是 name 維度）
  const spentByName = new Map(summary.byCategory.filter((c) => c.type === 'EXPENSE').map((c) => [c.name, c.amount]));

  const pct = (spent: number, budget: number) => (budget > 0 ? Math.round((spent / budget) * 100) : 0);

  return {
    month,
    overall: overall != null ? { budget: overall, spent: summary.totalExpense, pct: pct(summary.totalExpense, overall) } : null,
    byCategory: byCategory
      .map((b) => {
        const cat = catById.get(b.categoryId);
        if (!cat) return null;
        const spent = spentByName.get(cat.name) ?? 0;
        return { categoryId: b.categoryId, name: cat.name, icon: cat.icon, budget: b.amount, spent, pct: pct(spent, b.amount) };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
  };
}
