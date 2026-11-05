import { prisma } from '../prisma';
import type { ParsedTransaction, ParsedBillItem } from '../ai/gemini';
import { AccessScope } from '../lib/access';

// 別人「只看總額」的個人帳戶交易：算進總額，但不露出分類（分類就是明細）。
export const TOTAL_ONLY_BUCKET_NAME = '其他成員個人帳戶';

// 不公開帳戶在轉帳列表上的顯示名稱
export const HIDDEN_ACCOUNT_NAME = '不公開帳戶';

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
  creditCardId?: string | null;
  isShared?: boolean;
  // ---- 財務中樞 P1-6（文字記帳補強）----
  bookTo?: 'FAMILY' | 'BUSINESS'; // BUSINESS＝代墊公司費用（報帳狀態自動 PENDING）
  originalCurrency?: string | null; // 外幣：原幣別＋原幣金額，amount 是預估台幣
  originalAmount?: number | null;
  amountEstimated?: boolean;
  recordedByMemberId?: string | null; // 「幫 Apple 記」：memberId＝Apple，這裡記實際打字的人
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
      creditCardId: params.creditCardId ?? null,
      isShared: params.isShared ?? true,
      ...(params.bookTo === 'BUSINESS' ? { bookTo: 'BUSINESS' as const, reimburseStatus: 'PENDING' as const } : {}),
      ...(params.originalCurrency ? { originalCurrency: params.originalCurrency, originalAmount: params.originalAmount ?? null } : {}),
      ...(params.amountEstimated ? { amountEstimated: true } : {}),
      ...(params.recordedByMemberId && params.recordedByMemberId !== memberId ? { recordedByMemberId: params.recordedByMemberId } : {}),
    },
    include: { category: true, member: true, account: true, creditCard: true },
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

// 近 N 個月收支趨勢（舊→新），台北月界
export async function getTrend(familyId: string, months: number, scope: AccessScope): Promise<{ month: string; expense: number; income: number }[]> {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const list: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    list.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const start = new Date(`${list[0]}-01T00:00:00+08:00`);

  const txs = await prisma.transaction.findMany({
    where: { familyId, paidAt: { gte: start }, bookTo: 'FAMILY' }, // 代墊公司費用不算家庭收支（3.9.1）
    select: { amount: true, paidAt: true, accountId: true, creditCardId: true, category: { select: { type: true } } },
  });

  const map = new Map<string, { expense: number; income: number }>();
  list.forEach((m) => map.set(m, { expense: 0, income: 0 }));
  for (const t of txs) {
    if (!AccessScope.inTotals(scope.txLevel(t))) continue;
    const tp = new Date(t.paidAt.getTime() + 8 * 60 * 60 * 1000);
    const key = `${tp.getUTCFullYear()}-${String(tp.getUTCMonth() + 1).padStart(2, '0')}`;
    const bucket = map.get(key);
    if (!bucket) continue;
    const amt = Number(t.amount);
    if (t.category.type === 'INCOME') bucket.income += amt;
    else bucket.expense += amt;
  }
  return list.map((m) => ({ month: m, expense: Math.round((map.get(m)!.expense) * 100) / 100, income: Math.round((map.get(m)!.income) * 100) / 100 }));
}

export type MonthlySummary = {
  month: string;
  totalExpense: number;
  totalIncome: number;
  byCategory: { name: string; icon: string | null; type: 'EXPENSE' | 'INCOME'; amount: number }[];
  byMember: { memberId: string; name: string; amount: number }[]; // 僅統計支出占比
};

// 月度摘要：分類圓餅圖 + 成員支出占比（依 scope：看不到的不算；只看總額的算進總額但併成一塊、不露分類）
export async function getMonthlySummary(familyId: string, month: string, scope: AccessScope): Promise<MonthlySummary> {
  const { start, end } = monthRange(month);

  const txs = await prisma.transaction.findMany({
    where: { familyId, paidAt: { gte: start, lt: end }, bookTo: 'FAMILY' }, // 代墊公司費用不算家庭支出、分類、預算（3.9.1）
    include: { category: true, member: true },
  });

  let totalExpense = 0;
  let totalIncome = 0;
  const catMap = new Map<string, { name: string; icon: string | null; type: 'EXPENSE' | 'INCOME'; amount: number }>();
  const memMap = new Map<string, { memberId: string; name: string; amount: number }>();

  for (const t of txs) {
    const level = scope.txLevel(t);
    if (!AccessScope.inTotals(level)) continue;
    const amt = Number(t.amount);
    const type = t.category.type;
    if (type === 'INCOME') totalIncome += amt;
    else totalExpense += amt;

    const totalOnly = level === 'TOTAL';
    const catKey = totalOnly ? `__total_only_${type}` : t.categoryId;
    const cat =
      catMap.get(catKey) ??
      (totalOnly ? { name: TOTAL_ONLY_BUCKET_NAME, icon: null, type, amount: 0 } : { name: t.category.name, icon: t.category.icon, type, amount: 0 });
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
export async function getSettlement(familyId: string, month: string, scope: AccessScope): Promise<Settlement> {
  const { start, end } = monthRange(month);
  const [members, txs] = await Promise.all([
    prisma.familyMember.findMany({ where: { familyId } }),
    prisma.transaction.findMany({
      where: { familyId, paidAt: { gte: start, lt: end }, bookTo: 'FAMILY' }, // 公司費用不分帳
      include: { category: true },
    }),
  ]);

  const paidBy = new Map<string, number>();
  let totalExpense = 0;
  for (const t of txs) {
    if (t.category.type !== 'EXPENSE') continue;
    if (!t.isShared) continue; // 個人支出不納入分帳
    if (!AccessScope.inTotals(scope.txLevel(t))) continue; // 看不到的帳戶不算（只看總額的照算，分帳只露每人總數）
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

// 月轉帳列表搬到 services/transfer.ts（getMonthlyTransfers，P1-4 轉帳引擎）。

// 月度明細列表（新到舊）：只列看得到明細的；canEdit＝D10（共同或本人的個人帳戶）
export async function getMonthlyTransactions(familyId: string, month: string, scope: AccessScope) {
  const { start, end } = monthRange(month);
  const all = await prisma.transaction.findMany({
    where: { familyId, paidAt: { gte: start, lt: end } },
    include: { category: true, member: true, account: true, creditCard: true },
    orderBy: { paidAt: 'desc' },
  });
  const txs = all.filter((t) => scope.txLevel(t) === 'DETAIL');
  const members = await prisma.familyMember.findMany({ where: { familyId }, select: { id: true, displayName: true } });
  const names = new Map(members.map((m) => [m.id, m.displayName]));

  return txs.map((t) => ({
    id: t.id,
    amount: Number(t.amount),
    type: t.category.type,
    categoryName: t.category.name,
    categoryIcon: t.category.icon,
    note: t.note,
    memberName: t.member.displayName,
    isShared: t.isShared,
    accountId: t.accountId,
    creditCardId: t.creditCardId,
    // 付款顯示：帳戶或信用卡
    accountName: t.account?.name ?? t.creditCard?.name ?? null,
    accountIcon: t.account?.icon ?? t.creditCard?.icon ?? (t.creditCardId ? '💳' : null),
    paidAt: t.paidAt.toISOString(),
    source: t.source,
    canEdit: scope.canWriteTx(t),
    // 財務中樞 P1-6
    bookTo: t.bookTo,
    reimburseStatus: t.reimburseStatus,
    originalCurrency: t.originalCurrency,
    originalAmount: t.originalAmount == null ? null : Number(t.originalAmount),
    amountEstimated: t.amountEstimated,
    recordedByName: t.recordedByMemberId ? names.get(t.recordedByMemberId) ?? null : null,
  }));
}
