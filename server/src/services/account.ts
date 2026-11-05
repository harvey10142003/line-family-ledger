import { prisma } from '../prisma';
import type { AccountType, Visibility } from '@prisma/client';
import type { AccessLevel, AccessScope } from '../lib/access';
import { activeLegs } from '../lib/transfer-rules';

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
  // 財務中樞 P1-2：歸屬與可見範圍
  ownerMemberId: string | null;
  ownerName: string | null;
  visibility: Visibility;
  access: AccessLevel; // DETAIL＝看得到明細；TOTAL＝只看總額
  canEdit: boolean; // D10：共同或本人的才能改
};

// 帳戶餘額 = 期初 + 收入 - 支出 + 轉入 - 轉出
// 轉帳只算沒撤銷的；另一端是卡或負債時（繳卡費、還貸款、借出入）只動帳戶這一端。
// 連帶的利息、手續費是一般交易，已經算在收入／支出裡。
// 依 scope：別人 OWNER_ONLY 的帳戶不列；只看總額的列出餘額（餘額本來就是總額）。
export async function getAccountsWithBalances(familyId: string, includeArchived: boolean, scope: AccessScope): Promise<AccountWithBalance[]> {
  await ensureDefaultAccounts(familyId);

  const all = await prisma.account.findMany({
    where: { familyId, ...(includeArchived ? {} : { isArchived: false }) },
    orderBy: { sortOrder: 'asc' },
    include: { owner: { select: { displayName: true } } },
  });
  const accounts = all.filter((a) => scope.accountLevel(a.id) !== 'NONE');

  // 撈該家庭所有有帳戶的交易 + 轉帳，於記憶體加總（家庭規模足夠）
  const [txs, transfers] = await Promise.all([
    prisma.transaction.findMany({
      where: { familyId, accountId: { not: null } },
      select: { accountId: true, amount: true, category: { select: { type: true } } },
    }),
    prisma.transfer.findMany({
      where: { familyId, undoneAt: null },
      select: { fromAccountId: true, toAccountId: true, amount: true, confirmStatus: true, counterpartSide: true },
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
    const legs = activeLegs(tr); // D18：待對方確認的不算；對方 24 小時沒回只算建立者那一端
    if (tr.fromAccountId && legs.from) delta.set(tr.fromAccountId, (delta.get(tr.fromAccountId) ?? 0) - amt);
    if (tr.toAccountId && legs.to) delta.set(tr.toAccountId, (delta.get(tr.toAccountId) ?? 0) + amt);
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
      ownerMemberId: a.ownerMemberId,
      ownerName: a.owner?.displayName ?? null,
      visibility: a.visibility,
      access: scope.accountLevel(a.id),
      canEdit: scope.canWriteAccount(a.id),
    };
  });
}

// 記帳時把帳戶名稱（Gemini 解析出的提示）對應成 accountId；對不上用預設帳戶。
// 只考慮說話者「可以記進去」的帳戶（共同或自己的，D10）；預設帳戶若是別人的個人帳戶就往下找。
export async function resolveAccountId(familyId: string, accountName: string | null | undefined, scope: AccessScope): Promise<string | null> {
  await ensureDefaultAccounts(familyId);

  if (accountName) {
    const hit = await findAccountIdByName(familyId, accountName, scope);
    if (hit) return hit;
  }
  const candidates = await prisma.account.findMany({
    where: { familyId, isArchived: false },
    orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
    select: { id: true },
  });
  return candidates.find((a) => scope.canWriteAccount(a.id))?.id ?? null;
}

// 精準比對帳戶名稱（找不到回 null，不退預設）— 給「未知付款→詢問新增」判斷用。只回可寫入的。
export async function findAccountIdByName(familyId: string, name: string, scope: AccessScope): Promise<string | null> {
  const hit = await prisma.account.findFirst({ where: { familyId, name, isArchived: false } });
  return hit && scope.canWriteAccount(hit.id) ? hit.id : null;
}

export async function createAccount(params: {
  familyId: string;
  name: string;
  type?: AccountType;
  icon?: string | null;
  openingBalance?: number;
  // 歸屬：呼叫端先用 scope.resolveOwnership 正規化（只能共同或自己）；不給＝共同（舊行為）
  ownerMemberId?: string | null;
  visibility?: Visibility;
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
      ...(params.ownerMemberId ? { ownerMemberId: params.ownerMemberId, visibility: params.visibility ?? 'FAMILY_TOTAL_ONLY' } : {}),
    },
  });
}

export async function updateAccount(
  params: {
    familyId: string;
    accountId: string;
    name?: string;
    type?: AccountType;
    icon?: string | null;
    openingBalance?: number;
    isDefault?: boolean;
    isArchived?: boolean;
    ownerMemberId?: unknown; // 自己的 memberId／null（改回共同）；其他值 → 403
    visibility?: unknown;
  },
  scope: AccessScope,
) {
  const acc = await prisma.account.findFirst({ where: { id: params.accountId, familyId: params.familyId } });
  if (!acc) throw new Error('account not found');
  scope.assertAccountWritable(acc.id); // D10：別人的個人帳戶不能改（看不到的回 404）
  const ownership =
    params.ownerMemberId !== undefined || params.visibility !== undefined
      ? scope.resolveOwnership(acc, { ownerMemberId: params.ownerMemberId, visibility: params.visibility })
      : null;

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
      ...(ownership ?? {}),
    },
  });
}

// 轉帳的建立、撤銷、對帳狀態搬到 services/transfer.ts（P1-4 轉帳引擎，唯一出口）。
