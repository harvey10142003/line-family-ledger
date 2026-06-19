import { prisma } from '../prisma';
import type { ParsedTransaction, ParsedBillItem } from '../ai/gemini';

// 台灣時區月份邊界：把 "YYYY-MM" 轉成 [start, end) 的 UTC Date
// Zeabur 容器是 UTC，使用者在台灣(+08:00)，月報表要以台北日界切分。
function monthRange(month: string): { start: Date; end: Date } {
  const [y, m] = month.split('-').map(Number);
  // 用 +08:00 明確指定時區，JS Date 會正確換算成 UTC 內部值
  const start = new Date(`${month}-01T00:00:00+08:00`);
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const end = new Date(`${nextY}-${String(nextM).padStart(2, '0')}-01T00:00:00+08:00`);
  return { start, end };
}

// 把 Gemini 解析結果寫入一筆交易。回傳含分類資訊方便回覆訊息。
export async function recordTransaction(params: {
  familyId: string;
  memberId: string;
  parsed: ParsedTransaction;
  source?: 'TEXT' | 'PHOTO' | 'MANUAL';
  paidAt?: Date;
  accountId?: string | null;
}) {
  const { familyId, memberId, parsed } = params;

  // 以分類名稱對應該家庭的分類；理論上 parse 階段已限制在清單內
  let category = await prisma.category.findUnique({
    where: { familyId_name: { familyId, name: parsed.categoryName } },
  });

  // 防呆：分類萬一不存在（被刪改），退回「其他支出/其他收入」
  if (!category) {
    const fallbackName = parsed.type === 'INCOME' ? '其他收入' : '其他支出';
    category = await prisma.category.findUnique({
      where: { familyId_name: { familyId, name: fallbackName } },
    });
  }
  if (!category) throw new Error(`no category resolved for family ${familyId}`);

  const tx = await prisma.transaction.create({
    data: {
      familyId,
      memberId,
      categoryId: category.id,
      amount: parsed.amount,
      note: parsed.note || null,
      paidAt: params.paidAt ?? new Date(),
      source: params.source ?? 'TEXT',
      accountId: params.accountId ?? null,
    },
    include: { category: true, member: true, account: true },
  });

  return tx;
}

// 批次寫入（PDF 帳單匯入）。回傳成功寫入筆數與總額。
export async function recordTransactionsBatch(params: {
  familyId: string;
  memberId: string;
  items: ParsedBillItem[];
  source?: 'TEXT' | 'PHOTO' | 'MANUAL';
  accountId?: string | null;
}): Promise<{ count: number; total: number }> {
  const { familyId, memberId, items } = params;

  // 先把家庭分類載成 name→id 對照，避免每筆都查一次
  const cats = await prisma.category.findMany({ where: { familyId } });
  const byName = new Map(cats.map((c) => [c.name, c]));
  const fallbackExpense = byName.get('其他支出');
  const fallbackIncome = byName.get('其他收入');

  const rows = items
    .map((it) => {
      const cat = byName.get(it.categoryName) ?? (it.type === 'INCOME' ? fallbackIncome : fallbackExpense);
      if (!cat) return null;
      return {
        familyId,
        memberId,
        categoryId: cat.id,
        amount: it.amount,
        note: it.note || null,
        paidAt: it.paidAt ? new Date(`${it.paidAt}T12:00:00+08:00`) : new Date(),
        source: params.source ?? 'MANUAL',
        accountId: params.accountId ?? null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) return { count: 0, total: 0 };

  await prisma.transaction.createMany({ data: rows });
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return { count: rows.length, total: Math.round(total * 100) / 100 };
}

export type MonthlySummary = {
  month: string;
  totalExpense: number;
  totalIncome: number;
  byCategory: { name: string; icon: string | null; type: 'EXPENSE' | 'INCOME'; amount: number }[];
  byMember: { memberId: string; name: string; amount: number }[]; // 僅統計支出占比
};

// 月度摘要：分類圓餅圖 + 成員支出占比
export async function getMonthlySummary(familyId: string, month: string): Promise<MonthlySummary> {
  const { start, end } = monthRange(month);

  const txs = await prisma.transaction.findMany({
    where: { familyId, paidAt: { gte: start, lt: end } },
    include: { category: true, member: true },
  });

  let totalExpense = 0;
  let totalIncome = 0;
  const catMap = new Map<string, { name: string; icon: string | null; type: 'EXPENSE' | 'INCOME'; amount: number }>();
  const memMap = new Map<string, { memberId: string; name: string; amount: number }>();

  for (const t of txs) {
    const amt = Number(t.amount);
    const type = t.category.type;
    if (type === 'INCOME') totalIncome += amt;
    else totalExpense += amt;

    const catKey = t.categoryId;
    const cat = catMap.get(catKey) ?? { name: t.category.name, icon: t.category.icon, type, amount: 0 };
    cat.amount += amt;
    catMap.set(catKey, cat);

    // 成員占比只算支出
    if (type === 'EXPENSE') {
      const mem = memMap.get(t.memberId) ?? { memberId: t.memberId, name: t.member.displayName, amount: 0 };
      mem.amount += amt;
      memMap.set(t.memberId, mem);
    }
  }

  return {
    month,
    totalExpense: Math.round(totalExpense * 100) / 100,
    totalIncome: Math.round(totalIncome * 100) / 100,
    byCategory: [...catMap.values()].sort((a, b) => b.amount - a.amount),
    byMember: [...memMap.values()].sort((a, b) => b.amount - a.amount),
  };
}

export type Settlement = {
  month: string;
  totalExpense: number;
  perPersonShare: number;
  memberCount: number;
  balances: { memberId: string; name: string; paid: number; balance: number }[];
  transfers: { fromName: string; toName: string; amount: number }[];
};

// 分帳結算：假設當月支出由全家均分，記錄者視為付款人。
// balance = 已付 - 應分攤；正數代表多付（該收回），負數代表少付（該補）。
export async function getSettlement(familyId: string, month: string): Promise<Settlement> {
  const { start, end } = monthRange(month);
  const [members, txs] = await Promise.all([
    prisma.familyMember.findMany({ where: { familyId } }),
    prisma.transaction.findMany({
      where: { familyId, paidAt: { gte: start, lt: end } },
      include: { category: true },
    }),
  ]);

  const paidBy = new Map<string, number>();
  let totalExpense = 0;
  for (const t of txs) {
    if (t.category.type !== 'EXPENSE') continue;
    const amt = Number(t.amount);
    totalExpense += amt;
    paidBy.set(t.memberId, (paidBy.get(t.memberId) ?? 0) + amt);
  }

  const count = members.length || 1;
  const share = Math.round((totalExpense / count) * 100) / 100;

  const balances = members.map((m) => {
    const paid = Math.round((paidBy.get(m.id) ?? 0) * 100) / 100;
    return { memberId: m.id, name: m.displayName, paid, balance: Math.round((paid - share) * 100) / 100 };
  });

  // 貪婪結算：欠款方（負）轉給多付方（正）
  const debtors = balances.filter((b) => b.balance < -0.005).map((b) => ({ name: b.name, amt: -b.balance })).sort((a, b) => b.amt - a.amt);
  const creditors = balances.filter((b) => b.balance > 0.005).map((b) => ({ name: b.name, amt: b.balance })).sort((a, b) => b.amt - a.amt);

  const transfers: { fromName: string; toName: string; amount: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    const amount = Math.round(pay * 100) / 100;
    if (amount > 0) transfers.push({ fromName: debtors[i].name, toName: creditors[j].name, amount });
    debtors[i].amt -= pay;
    creditors[j].amt -= pay;
    if (debtors[i].amt < 0.005) i++;
    if (creditors[j].amt < 0.005) j++;
  }

  return {
    month,
    totalExpense: Math.round(totalExpense * 100) / 100,
    perPersonShare: share,
    memberCount: count,
    balances,
    transfers,
  };
}

// 月度轉帳列表
export async function getMonthlyTransfers(familyId: string, month: string) {
  const { start, end } = monthRange(month);
  const rows = await prisma.transfer.findMany({
    where: { familyId, transferredAt: { gte: start, lt: end } },
    include: { fromAccount: true, toAccount: true, member: true },
    orderBy: { transferredAt: 'desc' },
  });
  return rows.map((t) => ({
    id: t.id,
    amount: Number(t.amount),
    fromName: t.fromAccount.name,
    toName: t.toAccount.name,
    note: t.note,
    memberName: t.member.displayName,
    transferredAt: t.transferredAt.toISOString(),
  }));
}

// 月度明細列表（新到舊）
export async function getMonthlyTransactions(familyId: string, month: string) {
  const { start, end } = monthRange(month);
  const txs = await prisma.transaction.findMany({
    where: { familyId, paidAt: { gte: start, lt: end } },
    include: { category: true, member: true, account: true },
    orderBy: { paidAt: 'desc' },
  });

  return txs.map((t) => ({
    id: t.id,
    amount: Number(t.amount),
    type: t.category.type,
    categoryName: t.category.name,
    categoryIcon: t.category.icon,
    note: t.note,
    memberName: t.member.displayName,
    accountId: t.accountId,
    accountName: t.account?.name ?? null,
    accountIcon: t.account?.icon ?? null,
    paidAt: t.paidAt.toISOString(),
    source: t.source,
  }));
}
