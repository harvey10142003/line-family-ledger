import { Router } from 'express';
import { prisma } from '../prisma';
import { getMonthlySummary, getMonthlyTransactions, getMonthlyTransfers, getSettlement } from '../services/transaction';
import { getBudgets, setBudget, getBudgetStatus } from '../services/budget';
import {
  getAccountsWithBalances,
  createAccount,
  updateAccount,
  createTransfer,
  resolveAccountId,
} from '../services/account';
import { getCreditCards, createCreditCard, updateCreditCard } from '../services/creditcard';
import type { AccountType } from '@prisma/client';

export const liffRouter = Router();

// 台北當月 "YYYY-MM"（server 為 UTC，需 +8h 再取年月）
function currentTaipeiMonth(): string {
  const now = new Date();
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return `${taipei.getUTCFullYear()}-${String(taipei.getUTCMonth() + 1).padStart(2, '0')}`;
}

// 驗證 month 格式 YYYY-MM，非法則退回當月
function resolveMonth(raw: unknown): string {
  if (typeof raw === 'string' && /^\d{4}-\d{2}$/.test(raw)) return raw;
  return currentTaipeiMonth();
}

// 從 header 取得 LINE userId 並查出歸屬家庭成員
async function resolveMember(lineUserId: string) {
  return prisma.familyMember.findFirst({
    where: { lineUserId },
    include: { family: true },
    orderBy: { joinedAt: 'desc' },
  });
}

// 給 LIFF 前端：以 LINE userId 查目前歸屬的家庭與成員資訊
liffRouter.get('/me', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });

  const member = await resolveMember(lineUserId);
  if (!member) return res.json({ joined: false });

  return res.json({
    joined: true,
    family: { id: member.family.id, name: member.family.name, code: member.family.familyCode },
    member: { id: member.id, role: member.role, displayName: member.displayName },
  });
});

// 月度摘要：總支出/總收入 + 分類占比 + 成員占比
liffRouter.get('/summary', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });

  const member = await resolveMember(lineUserId);
  if (!member) return res.status(404).json({ error: 'not in any family' });

  const month = resolveMonth(req.query.month);
  const summary = await getMonthlySummary(member.familyId, month);
  return res.json(summary);
});

// 月度明細列表（新到舊）
liffRouter.get('/transactions', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });

  const member = await resolveMember(lineUserId);
  if (!member) return res.status(404).json({ error: 'not in any family' });

  const month = resolveMonth(req.query.month);
  const items = await getMonthlyTransactions(member.familyId, month);
  return res.json({ month, items });
});

// 預算使用狀況（整體 + 各分類），含設定值
liffRouter.get('/budget-status', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });
  const member = await resolveMember(lineUserId);
  if (!member) return res.status(404).json({ error: 'not in any family' });

  const month = resolveMonth(req.query.month);
  const [status, budgets] = await Promise.all([
    getBudgetStatus(member.familyId, month),
    getBudgets(member.familyId),
  ]);
  return res.json({ ...status, settings: budgets });
});

// 設定預算（整體或某分類）。body: { categoryId: string|null, amount: number }
liffRouter.put('/budgets', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });
  const member = await resolveMember(lineUserId);
  if (!member) return res.status(404).json({ error: 'not in any family' });

  const { categoryId, amount } = (req.body ?? {}) as { categoryId?: string | null; amount?: number };
  if (typeof amount !== 'number' || Number.isNaN(amount)) {
    return res.status(400).json({ error: 'amount must be a number' });
  }
  // 若指定 categoryId，驗證屬於該家庭
  if (categoryId) {
    const cat = await prisma.category.findFirst({ where: { id: categoryId, familyId: member.familyId } });
    if (!cat) return res.status(400).json({ error: 'invalid categoryId' });
  }

  await setBudget(member.familyId, categoryId ?? null, amount);
  return res.json(await getBudgets(member.familyId));
});

// 分帳結算
liffRouter.get('/settlement', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });
  const member = await resolveMember(lineUserId);
  if (!member) return res.status(404).json({ error: 'not in any family' });

  const month = resolveMonth(req.query.month);
  return res.json(await getSettlement(member.familyId, month));
});

// 帳戶清單（含餘額）
liffRouter.get('/accounts', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });
  const member = await resolveMember(lineUserId);
  if (!member) return res.status(404).json({ error: 'not in any family' });

  const includeArchived = req.query.includeArchived === '1';
  return res.json({ accounts: await getAccountsWithBalances(member.familyId, includeArchived) });
});

// 新增帳戶
liffRouter.post('/accounts', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });
  const member = await resolveMember(lineUserId);
  if (!member) return res.status(404).json({ error: 'not in any family' });

  const { name, type, icon, openingBalance } = (req.body ?? {}) as {
    name?: string;
    type?: AccountType;
    icon?: string | null;
    openingBalance?: number;
  };
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const acc = await createAccount({ familyId: member.familyId, name: name.trim(), type, icon, openingBalance });
    return res.json(acc);
  } catch (err) {
    return res.status(400).json({ error: String(err) });
  }
});

// 編輯帳戶（名稱/類型/圖示/期初/預設/封存）
liffRouter.put('/accounts/:id', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });
  const member = await resolveMember(lineUserId);
  if (!member) return res.status(404).json({ error: 'not in any family' });

  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const acc = await updateAccount({
      familyId: member.familyId,
      accountId: req.params.id,
      name: body.name as string | undefined,
      type: body.type as AccountType | undefined,
      icon: body.icon as string | null | undefined,
      openingBalance: body.openingBalance as number | undefined,
      isDefault: body.isDefault as boolean | undefined,
      isArchived: body.isArchived as boolean | undefined,
    });
    return res.json(acc);
  } catch (err) {
    return res.status(400).json({ error: String(err) });
  }
});

// 轉帳列表
liffRouter.get('/transfers', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });
  const member = await resolveMember(lineUserId);
  if (!member) return res.status(404).json({ error: 'not in any family' });

  const month = resolveMonth(req.query.month);
  return res.json({ month, items: await getMonthlyTransfers(member.familyId, month) });
});

// 建立轉帳
liffRouter.post('/transfers', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });
  const member = await resolveMember(lineUserId);
  if (!member) return res.status(404).json({ error: 'not in any family' });

  const { fromAccountId, toAccountId, amount, note } = (req.body ?? {}) as {
    fromAccountId?: string;
    toAccountId?: string;
    amount?: number;
    note?: string | null;
  };
  if (!fromAccountId || !toAccountId || typeof amount !== 'number') {
    return res.status(400).json({ error: 'fromAccountId, toAccountId, amount required' });
  }
  try {
    const tr = await createTransfer({
      familyId: member.familyId,
      memberId: member.id,
      fromAccountId,
      toAccountId,
      amount,
      note,
    });
    return res.json(tr);
  } catch (err) {
    return res.status(400).json({ error: String(err) });
  }
});

// 信用卡清單（含本期已用/可用額度/結算日/繳費日）
liffRouter.get('/credit-cards', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });
  const member = await resolveMember(lineUserId);
  if (!member) return res.status(404).json({ error: 'not in any family' });

  const includeArchived = req.query.includeArchived === '1';
  return res.json({ cards: await getCreditCards(member.familyId, includeArchived) });
});

// 新增信用卡（需額度/結算日/繳費日）
liffRouter.post('/credit-cards', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });
  const member = await resolveMember(lineUserId);
  if (!member) return res.status(404).json({ error: 'not in any family' });

  const { name, creditLimit, statementDay, dueDay } = (req.body ?? {}) as {
    name?: string;
    creditLimit?: number;
    statementDay?: number;
    dueDay?: number;
  };
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const card = await createCreditCard({ familyId: member.familyId, name: name.trim(), creditLimit, statementDay, dueDay });
    return res.json(card);
  } catch (err) {
    return res.status(400).json({ error: String(err) });
  }
});

// 編輯信用卡
liffRouter.put('/credit-cards/:id', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });
  const member = await resolveMember(lineUserId);
  if (!member) return res.status(404).json({ error: 'not in any family' });

  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const card = await updateCreditCard({
      familyId: member.familyId,
      cardId: req.params.id,
      name: body.name as string | undefined,
      creditLimit: body.creditLimit as number | undefined,
      statementDay: body.statementDay as number | undefined,
      dueDay: body.dueDay as number | undefined,
      isArchived: body.isArchived as boolean | undefined,
    });
    return res.json(card);
  } catch (err) {
    return res.status(400).json({ error: String(err) });
  }
});

// 改某筆交易的帳戶
liffRouter.patch('/transactions/:id/account', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });
  const member = await resolveMember(lineUserId);
  if (!member) return res.status(404).json({ error: 'not in any family' });

  const { accountId } = (req.body ?? {}) as { accountId?: string | null };
  // 驗證交易屬於該家庭
  const tx = await prisma.transaction.findFirst({ where: { id: req.params.id, familyId: member.familyId } });
  if (!tx) return res.status(404).json({ error: 'transaction not found' });
  // 驗證帳戶屬於該家庭（null 代表取消指定）
  if (accountId) {
    const acc = await prisma.account.findFirst({ where: { id: accountId, familyId: member.familyId } });
    if (!acc) return res.status(400).json({ error: 'invalid accountId' });
  }
  const updated = await prisma.transaction.update({
    where: { id: req.params.id },
    data: { accountId: accountId ?? null },
  });
  return res.json({ id: updated.id, accountId: updated.accountId });
});

// CSV 匯出（Excel 可開，加 UTF-8 BOM 避免中文亂碼）
liffRouter.get('/export', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });
  const member = await resolveMember(lineUserId);
  if (!member) return res.status(404).json({ error: 'not in any family' });

  const month = resolveMonth(req.query.month);
  const items = await getMonthlyTransactions(member.familyId, month);

  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['日期', '類型', '分類', '帳戶', '備註', '金額', '記錄者', '來源'];
  const lines = items.map((t) =>
    [
      t.paidAt.slice(0, 10),
      t.type === 'INCOME' ? '收入' : '支出',
      t.categoryName,
      t.accountName ?? '',
      t.note ?? '',
      t.amount,
      t.memberName,
      t.source,
    ].map(esc).join(','),
  );
  const csv = '﻿' + [header.join(','), ...lines].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ledger-${month}.csv"`);
  return res.send(csv);
});
