import { prisma } from '../prisma';
import type { AccountType } from '@prisma/client';

// 建立家庭時 / 首次使用帳戶功能時自動套用的預設帳戶
// 信用卡已獨立為 CreditCard，預設帳戶 = 現金 / 銀行 / 電子錢包
export const DEFAULT_ACCOUNTS: { name: string; type: AccountType; icon: string; isDefault: boolean; sortOrder: number }[] = [
  { name: '現金', type: 'CASH', icon: '💵', isDefault: true, sortOrder: 1 },
  { name: '銀行', type: 'BANK', icon: '🏦', isDefault: false, sortOrder: 2 },
  { name: '電子錢包', type: 'EPAYMENT', icon: '👛', isDefault: false, sortOrder: 3 },
];

// 確保家庭有預設帳戶（含舊家庭 lazy 補建）。
export async function ensureDefaultAccounts(familyId: string): Promise<void> {
  const count = await prisma.account.count({ where: { familyId } });
  if (count === 0) {
    await prisma.account.createMany({ data: DEFAULT_ACCOUNTS.map((a) => ({ familyId, ...a })) });
  }
  // 既有家庭遷移：把舊的「信用卡」帳戶移出帳戶（信用卡已獨立成 CreditCard）
  await prisma.account.updateMany({
    where: { familyId, type: 'CREDIT_CARD', isArchived: false },
    data: { isArchived: true },
  });
  // 確保有「電子錢包」帳戶（舊家庭在 EPAYMENT 出現前種的補一個）
  const hasEpayment = await prisma.account.findFirst({ where: { familyId, type: 'EPAYMENT', isArchived: false } });
  if (!hasEpayment) {
    const max = await prisma.account.aggregate({ where: { familyId }, _max: { sortOrder: true } });
    await prisma.account.create({
      data: { familyId, name: '電子錢包', type: 'EPAYMENT', icon: '👛', sortOrder: (max._max.sortOrder ?? 0) + 1 },
    });
  }
}

export type AccountWithBalance = {
  id: string;
  name: string;
  type: AccountType;
  icon: string | null;
  openingBalance: number;
  balance: number;
  isDefault: boolean;
  isArchived: boolean;
  sortOrder: number;
};

// 帳戶餘額 = 期初 + 收入 - 支出 + 轉入 - 轉出
export async function getAccountsWithBalances(familyId: string, includeArchived = false): Promise<AccountWithBalance[]> {
  await ensureDefaultAccounts(familyId);

  const accounts = await prisma.account.findMany({
    where: { familyId, ...(includeArchived ? {} : { isArchived: false }) },
    orderBy: { sortOrder: 'asc' },
  });

  // 撈該家庭所有有帳戶的交易 + 轉帳，於記憶體加總（家庭規模足夠）
  const [txs, transfers] = await Promise.all([
    prisma.transaction.findMany({
      where: { familyId, accountId: { not: null } },
      select: { accountId: true, amount: true, category: { select: { type: true } } },
    }),
    prisma.transfer.findMany({
      where: { familyId },
      select: { fromAccountId: true, toAccountId: true, amount: true },
    }),
  ]);

  const delta = new Map<string, number>();
  for (const t of txs) {
    if (!t.accountId) continue;
    const amt = Number(t.amount);
    delta.set(t.accountId, (delta.get(t.accountId) ?? 0) + (t.category.type === 'INCOME' ? amt : -amt));
  }
  for (const tr of transfers) {
    const amt = Number(tr.amount);
    delta.set(tr.fromAccountId, (delta.get(tr.fromAccountId) ?? 0) - amt);
    delta.set(tr.toAccountId, (delta.get(tr.toAccountId) ?? 0) + amt);
  }

  return accounts.map((a) => {
    const opening = Number(a.openingBalance);
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      icon: a.icon,
      openingBalance: opening,
      balance: Math.round((opening + (delta.get(a.id) ?? 0)) * 100) / 100,
      isDefault: a.isDefault,
      isArchived: a.isArchived,
      sortOrder: a.sortOrder,
    };
  });
}

// 記帳時把帳戶名稱（Gemini 解析出的提示）對應成 accountId；對不上用預設帳戶
export async function resolveAccountId(familyId: string, accountName?: string | null): Promise<string | null> {
  await ensureDefaultAccounts(familyId);

  if (accountName) {
    const hit = await prisma.account.findFirst({
      where: { familyId, name: accountName, isArchived: false },
    });
    if (hit) return hit.id;
  }
  const def = await prisma.account.findFirst({
    where: { familyId, isArchived: false },
    orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
  });
  return def?.id ?? null;
}

// 精準比對帳戶名稱（找不到回 null，不退預設）— 給「未知付款→詢問新增」判斷用
export async function findAccountIdByName(familyId: string, name: string): Promise<string | null> {
  const hit = await prisma.account.findFirst({ where: { familyId, name, isArchived: false } });
  return hit?.id ?? null;
}

export async function createAccount(params: {
  familyId: string;
  name: string;
  type?: AccountType;
  icon?: string | null;
  openingBalance?: number;
}) {
  const max = await prisma.account.aggregate({ where: { familyId: params.familyId }, _max: { sortOrder: true } });
  return prisma.account.create({
    data: {
      familyId: params.familyId,
      name: params.name,
      type: params.type ?? 'OTHER',
      icon: params.icon ?? null,
      openingBalance: params.openingBalance ?? 0,
      sortOrder: (max._max.sortOrder ?? 0) + 1,
    },
  });
}

export async function updateAccount(params: {
  familyId: string;
  accountId: string;
  name?: string;
  type?: AccountType;
  icon?: string | null;
  openingBalance?: number;
  isDefault?: boolean;
  isArchived?: boolean;
}) {
  const acc = await prisma.account.findFirst({ where: { id: params.accountId, familyId: params.familyId } });
  if (!acc) throw new Error('account not found');

  // 設為預設 → 其他取消預設
  if (params.isDefault === true) {
    await prisma.account.updateMany({ where: { familyId: params.familyId }, data: { isDefault: false } });
  }

  return prisma.account.update({
    where: { id: params.accountId },
    data: {
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.type !== undefined ? { type: params.type } : {}),
      ...(params.icon !== undefined ? { icon: params.icon } : {}),
      ...(params.openingBalance !== undefined ? { openingBalance: params.openingBalance } : {}),
      ...(params.isDefault !== undefined ? { isDefault: params.isDefault } : {}),
      ...(params.isArchived !== undefined ? { isArchived: params.isArchived } : {}),
    },
  });
}

export async function createTransfer(params: {
  familyId: string;
  memberId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  note?: string | null;
  transferredAt?: Date;
}) {
  if (params.fromAccountId === params.toAccountId) throw new Error('from/to accounts must differ');
  if (!(params.amount > 0)) throw new Error('amount must be positive');

  // 驗證兩個帳戶都屬於該家庭
  const accs = await prisma.account.findMany({
    where: { familyId: params.familyId, id: { in: [params.fromAccountId, params.toAccountId] } },
  });
  if (accs.length !== 2) throw new Error('invalid accounts');

  return prisma.transfer.create({
    data: {
      familyId: params.familyId,
      memberId: params.memberId,
      fromAccountId: params.fromAccountId,
      toAccountId: params.toAccountId,
      amount: params.amount,
      note: params.note ?? null,
      transferredAt: params.transferredAt ?? new Date(),
    },
    include: { fromAccount: true, toAccount: true },
  });
}
