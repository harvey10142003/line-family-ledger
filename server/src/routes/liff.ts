import { Router, type RequestHandler, type Response } from 'express';
import { prisma } from '../prisma';
import { getMonthlySummary, getMonthlyTransactions, getSettlement, getTrend } from '../services/transaction';
import { getSavingsGoals, createSavingsGoal, updateSavingsGoal, adjustSaved, deleteSavingsGoal } from '../services/savings';
import { getBudgets, setBudget, getBudgetStatus } from '../services/budget';
import { getAccountsWithBalances, createAccount, updateAccount } from '../services/account';
import { getCreditCards, createCreditCard, updateCreditCard } from '../services/creditcard';
import { createTransfer, undoTransfer, setReconcileStatus, getMonthlyTransfers, getTransferView, confirmTransfer, rejectTransfer } from '../services/transfer';
import { getOverview, snapshotMonth } from '../services/net-worth';
import { isMonth } from '../lib/net-worth';
import {
  getLiabilities,
  createLiability,
  updateLiability,
  addRateChange,
  getSchedule,
  getPayments,
  suggestPaymentSplit,
} from '../services/liability';
import { getCardStatements, getCardPrepaid, createCardStatement } from '../services/card-statement';
import { TransferRuleError } from '../lib/transfer-rules';
import { ledgerExportCsv } from '../lib/csv';
import { getRecurringRules, createRecurringRule, updateRecurringRule, deleteRecurringRule } from '../services/recurring';
import { loadAccessScope, getWritableTransaction } from '../services/access';
import { AccessError, type AccessScope } from '../lib/access';
import type { AccountType, Family, FamilyMember, RecurringFreq } from '@prisma/client';
import { ymdTaipei, taipeiNoon } from '../lib/time-tw';
import { createLiffAuth, authedLineUserId, resolveLoginChannelId } from '../lib/liff-auth';
import { logger } from '../logger';
import {
  auditCreateOp,
  listAuditForMember,
  recordAudit,
  recordPersonalViews,
  transferSubjectById,
  txSubject,
  writeAudit,
  type AuditEvent,
} from '../services/audit';
import { getLegalNameStatus, LegalNameInputError, setLegalName } from '../services/legal-name';
import { FieldKeyError } from '../lib/field-crypto';

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

// 以已驗證的 LINE userId（ID token sub）查出歸屬家庭成員
async function resolveMember(lineUserId: string) {
  return prisma.familyMember.findFirst({
    where: { lineUserId },
    include: { family: true },
    orderBy: { joinedAt: 'desc' },
  });
}

// 每個請求的「我是誰＋我看得到什麼」。由 requireMember 建好放在 res.locals，路由只從這裡拿，
// 讀寫權限一律問 scope（lib/access.ts），不在各路由自己寫條件。
type LiffCtx = { member: FamilyMember & { family: Family }; scope: AccessScope };

function ctx(res: Response): LiffCtx {
  const c = res.locals.liffCtx as LiffCtx | undefined;
  if (!c) throw new Error('liff ctx missing (requireMember not mounted)');
  return c;
}

const requireMember: RequestHandler = async (_req, res, next) => {
  try {
    const member = await resolveMember(authedLineUserId(res));
    if (!member) return res.status(404).json({ error: 'not in any family' });
    const scope = await loadAccessScope(member.familyId, member.id);
    res.locals.liffCtx = { member, scope } satisfies LiffCtx;
    return next();
  } catch (err) {
    return next(err);
  }
};

// 權限錯誤 → 403／404；其他沿用舊行為 400
function fail(res: Response, err: unknown) {
  if (err instanceof AccessError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err instanceof TransferRuleError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.detail ? { detail: err.detail } : {}) });
  return res.status(400).json({ error: String(err) });
}

// 帳戶／卡／負債「本身」的修改：歸屬或可見範圍有變＝權限變更，其他＝一般修改（P0-4）
function instrumentAudit(
  c: LiffCtx,
  targetType: 'ACCOUNT' | 'CREDIT_CARD' | 'LIABILITY',
  id: string,
  before: { ownerMemberId: string | null; visibility: string } | undefined,
  after: { ownerMemberId?: string | null; visibility?: string | null } | null | undefined,
  body: Record<string, unknown>,
): AuditEvent {
  const ownerAfter = after && 'ownerMemberId' in after ? after.ownerMemberId ?? null : before?.ownerMemberId ?? null;
  const visAfter = after && after.visibility ? after.visibility : before?.visibility ?? null;
  const permChanged = !!before && (ownerAfter !== before.ownerMemberId || visAfter !== before.visibility);
  return {
    familyId: c.member.familyId,
    actorMemberId: c.member.id,
    channel: 'LIFF',
    action: permChanged ? 'PERMISSION_CHANGE' : 'EDIT',
    targetType,
    targetId: id,
    subjectMemberId: ownerAfter ?? before?.ownerMemberId ?? null,
    detail: {
      fields: Object.keys(body).filter((k) => /^[A-Za-z]{1,30}$/.test(k)).slice(0, 20),
      ...(permChanged
        ? { ownerBefore: before?.ownerMemberId ?? null, ownerAfter, visibilityBefore: before?.visibility ?? null, visibilityAfter: visAfter }
        : {}),
    },
  };
}

// 轉帳列表裡「看得到明細」的那幾端的主人（記 VIEW_PERSONAL 用）
async function transferListOwners(scope: AccessScope, familyId: string, ids: string[]): Promise<(string | null | undefined)[]> {
  if (!ids.length) return [];
  const ends = await prisma.transfer.findMany({
    where: { id: { in: ids }, familyId },
    select: { fromAccountId: true, toAccountId: true, toCreditCardId: true, fromLiabilityId: true, toLiabilityId: true },
  });
  const owners = new Set<string | null | undefined>();
  for (const e of ends) {
    for (const id of [e.fromAccountId, e.toAccountId]) if (id && scope.accountLevel(id) === 'DETAIL') owners.add(scope.account(id)?.ownerMemberId);
    if (e.toCreditCardId && scope.cardLevel(e.toCreditCardId) === 'DETAIL') owners.add(scope.card(e.toCreditCardId)?.ownerMemberId);
    for (const id of [e.fromLiabilityId, e.toLiabilityId]) if (id && scope.liabilityLevel(id) === 'DETAIL') owners.add(scope.liability(id)?.ownerMemberId);
  }
  return [...owners];
}

// YYYY-MM-DD → 台北中午 Date；非法回 undefined
function parsePaidAt(raw: unknown): Date | undefined {
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T12:00:00+08:00`);
  return undefined;
}

/**
 * 建立 /api/liff 路由。auth＝LIFF ID token middleware（正式用 createLiffAuth；測試可換假 fetch 的同一支）。
 * 順序：auth → /me（未入家庭也能問）→ requireMember（建 scope）→ 其他全部路由。
 */
export function buildLiffRouter(auth: RequestHandler): Router {
  const r = Router();
  r.use(auth);

  // 給 LIFF 前端：以 LINE userId 查目前歸屬的家庭與成員資訊
  r.get('/me', async (_req, res) => {
    const member = await resolveMember(authedLineUserId(res));
    if (!member) return res.json({ joined: false });
    return res.json({
      joined: true,
      family: { id: member.family.id, name: member.family.name, code: member.family.familyCode },
      member: { id: member.id, role: member.role, displayName: member.displayName },
    });
  });

  r.use(requireMember);

  // 月度摘要：總支出/總收入 + 分類占比 + 成員占比
  r.get('/summary', async (req, res) => {
    const { member, scope } = ctx(res);
    return res.json(await getMonthlySummary(member.familyId, resolveMonth(req.query.month), scope));
  });

  // 月度明細列表（新到舊）
  r.get('/transactions', async (req, res) => {
    const { member, scope } = ctx(res);
    const month = resolveMonth(req.query.month);
    const items = await getMonthlyTransactions(member.familyId, month, scope);
    await recordPersonalViews({ scope, channel: 'LIFF', targetType: 'TRANSACTION_LIST', owners: items.map((t) => txSubject(scope, t)), detail: { month } });
    return res.json({ month, items });
  });

  // 預算使用狀況（整體 + 各分類），含設定值
  r.get('/budget-status', async (req, res) => {
    const { member, scope } = ctx(res);
    const month = resolveMonth(req.query.month);
    const [status, budgets] = await Promise.all([getBudgetStatus(member.familyId, month, scope), getBudgets(member.familyId)]);
    return res.json({ ...status, settings: budgets });
  });

  // 設定預算（整體或某分類）。body: { categoryId: string|null, amount: number }
  r.put('/budgets', async (req, res) => {
    const { member } = ctx(res);
    const { categoryId, amount } = (req.body ?? {}) as { categoryId?: string | null; amount?: number };
    if (typeof amount !== 'number' || Number.isNaN(amount)) {
      return res.status(400).json({ error: 'amount must be a number' });
    }
    if (categoryId) {
      const cat = await prisma.category.findFirst({ where: { id: categoryId, familyId: member.familyId } });
      if (!cat) return res.status(400).json({ error: 'invalid categoryId' });
    }
    await setBudget(member.familyId, categoryId ?? null, amount);
    return res.json(await getBudgets(member.familyId));
  });

  // 分帳結算
  r.get('/settlement', async (req, res) => {
    const { member, scope } = ctx(res);
    return res.json(await getSettlement(member.familyId, resolveMonth(req.query.month), scope));
  });

  // 帳戶清單（含餘額、歸屬、可見範圍、能不能改）
  r.get('/accounts', async (req, res) => {
    const { member, scope } = ctx(res);
    const includeArchived = req.query.includeArchived === '1';
    return res.json({ accounts: await getAccountsWithBalances(member.familyId, includeArchived, scope) });
  });

  // 新增帳戶（ownerMemberId：自己的 id＝個人帳戶，不給或 null＝共同；visibility 只對個人帳戶有效）
  r.post('/accounts', async (req, res) => {
    const { member, scope } = ctx(res);
    const { name, type, icon, openingBalance, ownerMemberId, visibility } = (req.body ?? {}) as {
      name?: string;
      type?: AccountType;
      icon?: string | null;
      openingBalance?: number;
      ownerMemberId?: unknown;
      visibility?: unknown;
    };
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
    try {
      const own = scope.resolveOwnership(null, { ownerMemberId, visibility });
      const acc = await createAccount({ familyId: member.familyId, name: name.trim(), type, icon, openingBalance, ...own });
      return res.json(acc);
    } catch (err) {
      return fail(res, err);
    }
  });

  // 編輯帳戶（名稱/類型/圖示/期初/預設/封存/歸屬/可見範圍）— 只有共同或本人的才能改
  r.put('/accounts/:id', async (req, res) => {
    const c = ctx(res);
    const { member, scope } = c;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const before = scope.account(req.params.id);
    try {
      const acc = await updateAccount(
        {
          familyId: member.familyId,
          accountId: req.params.id,
          name: body.name as string | undefined,
          type: body.type as AccountType | undefined,
          icon: body.icon as string | null | undefined,
          openingBalance: body.openingBalance as number | undefined,
          isDefault: body.isDefault as boolean | undefined,
          isArchived: body.isArchived as boolean | undefined,
          ownerMemberId: body.ownerMemberId,
          visibility: body.visibility,
        },
        scope,
      );
      await recordAudit(instrumentAudit(c, 'ACCOUNT', req.params.id, before, acc as any, body));
      return res.json(acc);
    } catch (err) {
      return fail(res, err);
    }
  });

  // 轉帳列表
  r.get('/transfers', async (req, res) => {
    const { member, scope } = ctx(res);
    const month = resolveMonth(req.query.month);
    const items = await getMonthlyTransfers(member.familyId, month, scope);
    await recordPersonalViews({
      scope,
      channel: 'LIFF',
      targetType: 'TRANSFER_LIST',
      owners: await transferListOwners(scope, member.familyId, items.map((t) => t.id)),
      detail: { month },
    });
    return res.json({ month, items });
  });

  // 建立轉帳（P1-4 轉帳引擎）：kind 不給＝一般帳戶轉帳（舊表單相容）。
  // 錢出去的那端要能改（共同或自己的）；進去的那端看得到即可。轉帳本身不算收支，只有利息、手續費另記。
  r.post('/transfers', async (req, res) => {
    const { member, scope } = ctx(res);
    try {
      const out = await createTransfer(member.familyId, member.id, (req.body ?? {}) as Record<string, unknown>, scope);
      const view = await getTransferView(member.familyId, out.transfer.id, scope);
      return res.json({ ...view, statement: out.statement, linkedTransactionIds: out.linkedTransactionIds, liabilityId: out.liabilityId });
    } catch (err) {
      return fail(res, err);
    }
  });

  // 撤銷轉帳：只有建立者；不刪資料，餘額／帳單已繳／負債本金／連帶收支全部還原
  r.post('/transfers/:id/undo', async (req, res) => {
    const { member, scope } = ctx(res);
    try {
      const out = await undoTransfer(member.familyId, member.id, req.params.id, scope);
      await recordAudit({ familyId: member.familyId, actorMemberId: member.id, channel: 'LIFF', action: 'UNDO', targetType: 'TRANSFER', targetId: req.params.id, subjectMemberId: await transferSubjectById(scope, req.params.id) });
      return res.json(out);
    } catch (err) {
      return fail(res, err);
    }
  });

  // 對帳狀態（跟對帳單對上了沒）。body: { reconcileStatus: 'RECONCILED' | 'UNRECONCILED' }
  r.patch('/transfers/:id/reconcile', async (req, res) => {
    const { member, scope } = ctx(res);
    try {
      return res.json(await setReconcileStatus(member.familyId, member.id, req.params.id, (req.body ?? {}).reconcileStatus, scope));
    } catch (err) {
      return fail(res, err);
    }
  });

  // D18：文字轉帳動到我的個人帳戶 → 我確認才生效／拒絕（LINE 確認卡之外，LIFF 轉帳列表也能按）
  r.post('/transfers/:id/confirm', async (req, res) => {
    const { member, scope } = ctx(res);
    try {
      await confirmTransfer(member.familyId, member.id, req.params.id);
      await recordAudit({ familyId: member.familyId, actorMemberId: member.id, channel: 'LIFF', action: 'CONFIRM', targetType: 'TRANSFER', targetId: req.params.id, subjectMemberId: member.id });
      return res.json(await getTransferView(member.familyId, req.params.id, scope));
    } catch (err) {
      return fail(res, err);
    }
  });

  r.post('/transfers/:id/reject', async (req, res) => {
    const { member, scope } = ctx(res);
    try {
      await rejectTransfer(member.familyId, member.id, req.params.id);
      await recordAudit({ familyId: member.familyId, actorMemberId: member.id, channel: 'LIFF', action: 'REJECT', targetType: 'TRANSFER', targetId: req.params.id, subjectMemberId: member.id });
      return res.json(await getTransferView(member.familyId, req.params.id, scope));
    } catch (err) {
      return fail(res, err);
    }
  });

  // ===== 全貌（P1-7）：淨資產、走勢、資產負債組成、本月現金流、負債還清時間表。數字全部依我的可見範圍由程式算 =====
  r.get('/overview', async (req, res) => {
    const { member, scope } = ctx(res);
    return res.json(await getOverview(member.familyId, scope, resolveMonth(req.query.month)));
  });

  // 手動重算某個月的快照（全家每人各一份；覆寫）。body: { month: 'YYYY-MM' }，不能是本月或未來
  r.post('/net-worth/snapshots', async (req, res) => {
    const { member } = ctx(res);
    const month = (req.body ?? {}).month;
    if (!isMonth(month) || month >= currentTaipeiMonth()) return res.status(400).json({ error: 'month must be a past YYYY-MM' });
    try {
      return res.json({ month, written: await snapshotMonth(member.familyId, month, { force: true }) });
    } catch (err) {
      return fail(res, err);
    }
  });

  // ===== 負債與借出（P1-3）=====
  r.get('/liabilities', async (req, res) => {
    const { member, scope } = ctx(res);
    return res.json(await getLiabilities(member.familyId, req.query.includeArchived === '1', scope));
  });

  r.post('/liabilities', async (req, res) => {
    const { member, scope } = ctx(res);
    try {
      const l = await createLiability(member.familyId, (req.body ?? {}) as Record<string, unknown>, scope);
      return res.json({ id: l.id });
    } catch (err) {
      return fail(res, err);
    }
  });

  r.put('/liabilities/:id', async (req, res) => {
    const c = ctx(res);
    const { member, scope } = c;
    const before = scope.liability(req.params.id);
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const l = await updateLiability(member.familyId, req.params.id, body, scope);
      await recordAudit(instrumentAudit(c, 'LIABILITY', req.params.id, before, l as any, body));
      return res.json({ id: l.id });
    } catch (err) {
      return fail(res, err);
    }
  });

  // 利率變動。body: { effectiveDate: 'YYYY-MM-DD', annualRate: number(%) }
  r.post('/liabilities/:id/rate-changes', async (req, res) => {
    const { member, scope } = ctx(res);
    try {
      return res.json({ rateChanges: await addRateChange(member.familyId, req.params.id, (req.body ?? {}) as Record<string, unknown>, scope) });
    } catch (err) {
      return fail(res, err);
    }
  });

  r.get('/liabilities/:id/schedule', async (req, res) => {
    const { member, scope } = ctx(res);
    try {
      const out = await getSchedule(member.familyId, req.params.id, scope);
      await recordPersonalViews({ scope, channel: 'LIFF', targetType: 'LIABILITY', targetId: req.params.id, owners: [scope.liability(req.params.id)?.ownerMemberId], detail: { view: 'schedule' } });
      return res.json(out);
    } catch (err) {
      return fail(res, err);
    }
  });

  r.get('/liabilities/:id/payments', async (req, res) => {
    const { member, scope } = ctx(res);
    try {
      const items = await getPayments(member.familyId, req.params.id, scope);
      await recordPersonalViews({ scope, channel: 'LIFF', targetType: 'LIABILITY', targetId: req.params.id, owners: [scope.liability(req.params.id)?.ownerMemberId], detail: { view: 'payments' } });
      return res.json({ items });
    } catch (err) {
      return fail(res, err);
    }
  });

  // 只知道總額時建議本金／利息怎麼拆。?total=18000&date=YYYY-MM-DD
  r.get('/liabilities/:id/suggest-split', async (req, res) => {
    const { member, scope } = ctx(res);
    try {
      const date = taipeiNoon(req.query.date) ? String(req.query.date) : ymdTaipei(new Date());
      return res.json(await suggestPaymentSplit(member.familyId, req.params.id, Number(req.query.total), date, scope));
    } catch (err) {
      return fail(res, err);
    }
  });

  // ===== 信用卡帳單（P1-4 繳卡費沖這裡；P2 由丟件自動建立）=====
  r.get('/credit-cards/:id/statements', async (req, res) => {
    const { member, scope } = ctx(res);
    try {
      const items = await getCardStatements(member.familyId, req.params.id, scope);
      await recordPersonalViews({ scope, channel: 'LIFF', targetType: 'CARD_STATEMENT', targetId: req.params.id, owners: [scope.card(req.params.id)?.ownerMemberId] });
      // prepaid：還沒沖到任何一期、付款日晚於最近一期結帳日的繳卡費（預繳，規則 A）；下一期帳單建立時自動抵扣
      return res.json({ items, prepaid: await getCardPrepaid(member.familyId, req.params.id) });
    } catch (err) {
      return fail(res, err);
    }
  });

  r.post('/credit-cards/:id/statements', async (req, res) => {
    const { member, scope } = ctx(res);
    try {
      return res.json(await createCardStatement(member.familyId, req.params.id, (req.body ?? {}) as Record<string, unknown>, scope));
    } catch (err) {
      return fail(res, err);
    }
  });

  // 信用卡清單（含本期已用/可用額度/結算日/繳費日、歸屬）
  r.get('/credit-cards', async (req, res) => {
    const { member, scope } = ctx(res);
    const includeArchived = req.query.includeArchived === '1';
    return res.json({ cards: await getCreditCards(member.familyId, includeArchived, scope) });
  });

  // 新增信用卡（需額度/結算日/繳費日；歸屬規則同帳戶）
  r.post('/credit-cards', async (req, res) => {
    const { member, scope } = ctx(res);
    const { name, creditLimit, statementDay, dueDay, ownerMemberId, visibility } = (req.body ?? {}) as {
      name?: string;
      creditLimit?: number;
      statementDay?: number;
      dueDay?: number;
      ownerMemberId?: unknown;
      visibility?: unknown;
    };
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
    try {
      const own = scope.resolveOwnership(null, { ownerMemberId, visibility });
      const card = await createCreditCard({ familyId: member.familyId, name: name.trim(), creditLimit, statementDay, dueDay, ...own });
      return res.json(card);
    } catch (err) {
      return fail(res, err);
    }
  });

  // 編輯信用卡 — 只有共同或本人的才能改
  r.put('/credit-cards/:id', async (req, res) => {
    const c = ctx(res);
    const { member, scope } = c;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const before = scope.card(req.params.id);
    try {
      const card = await updateCreditCard(
        {
          familyId: member.familyId,
          cardId: req.params.id,
          name: body.name as string | undefined,
          creditLimit: body.creditLimit as number | undefined,
          statementDay: body.statementDay as number | undefined,
          dueDay: body.dueDay as number | undefined,
          isArchived: body.isArchived as boolean | undefined,
          ownerMemberId: body.ownerMemberId,
          visibility: body.visibility,
        },
        scope,
      );
      await recordAudit(instrumentAudit(c, 'CREDIT_CARD', req.params.id, before, card as any, body));
      return res.json(card);
    } catch (err) {
      return fail(res, err);
    }
  });

  // 改某筆交易的帳戶（原本的與新的帳戶都要能寫）
  r.patch('/transactions/:id/account', async (req, res) => {
    const { member, scope } = ctx(res);
    const { accountId } = (req.body ?? {}) as { accountId?: string | null };
    try {
      const old = await getWritableTransaction(scope, req.params.id);
      if (accountId) {
        const acc = await prisma.account.findFirst({ where: { id: accountId, familyId: member.familyId } });
        if (!acc) return res.status(400).json({ error: 'invalid accountId' });
        scope.assertAccountWritable(accountId);
      }
      const [updated] = await prisma.$transaction([
        prisma.transaction.update({ where: { id: req.params.id }, data: { accountId: accountId ?? null } }),
        auditCreateOp({
          familyId: member.familyId,
          actorMemberId: member.id,
          channel: 'LIFF',
          action: 'EDIT',
          targetType: 'TRANSACTION',
          targetId: req.params.id,
          subjectMemberId: txSubject(scope, old) ?? txSubject(scope, { accountId: accountId ?? null }),
          detail: { fields: ['accountId'] },
        }),
      ]);
      return res.json({ id: updated.id, accountId: updated.accountId });
    } catch (err) {
      if (err instanceof AccessError && err.status === 404) return res.status(404).json({ error: 'transaction not found', code: err.code });
      return fail(res, err);
    }
  });

  // 收支趨勢（近 N 月）
  r.get('/trend', async (req, res) => {
    const { member, scope } = ctx(res);
    const months = Math.min(Math.max(Number(req.query.months) || 6, 3), 12);
    return res.json({ trend: await getTrend(member.familyId, months, scope) });
  });

  // ===== 儲蓄目標（家庭層級，不分歸屬）=====
  r.get('/savings', async (_req, res) => {
    const { member } = ctx(res);
    return res.json({ goals: await getSavingsGoals(member.familyId) });
  });

  r.post('/savings', async (req, res) => {
    const { member } = ctx(res);
    const b = (req.body ?? {}) as any;
    if (!b.name?.trim() || typeof b.targetAmount !== 'number' || !(b.targetAmount > 0)) {
      return res.status(400).json({ error: 'name and positive targetAmount required' });
    }
    const g = await createSavingsGoal({ familyId: member.familyId, name: b.name.trim(), targetAmount: b.targetAmount, savedAmount: b.savedAmount, targetDate: b.targetDate });
    return res.json({ id: g.id });
  });

  r.put('/savings/:id', async (req, res) => {
    const { member } = ctx(res);
    const b = (req.body ?? {}) as any;
    try {
      await updateSavingsGoal({ familyId: member.familyId, id: req.params.id, name: b.name, targetAmount: b.targetAmount, targetDate: b.targetDate, isArchived: b.isArchived });
      return res.json({ ok: true });
    } catch (err) {
      return fail(res, err);
    }
  });

  // 存入/取出（body.delta，正=存入 負=取出）
  r.post('/savings/:id/adjust', async (req, res) => {
    const { member } = ctx(res);
    const delta = Number((req.body ?? {}).delta);
    if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'delta required' });
    try {
      const g = await adjustSaved(member.familyId, req.params.id, delta);
      return res.json({ savedAmount: Number(g.savedAmount) });
    } catch (err) {
      return fail(res, err);
    }
  });

  r.delete('/savings/:id', async (req, res) => {
    const { member } = ctx(res);
    try {
      await deleteSavingsGoal(member.familyId, req.params.id);
      await recordAudit({ familyId: member.familyId, actorMemberId: member.id, channel: 'LIFF', action: 'DELETE', targetType: 'SAVINGS_GOAL', targetId: req.params.id });
      return res.json({ ok: true });
    } catch (err) {
      return fail(res, err);
    }
  });

  // ===== 固定收支（付款工具權限同交易）=====
  r.get('/recurring', async (_req, res) => {
    const { member, scope } = ctx(res);
    return res.json({ rules: await getRecurringRules(member.familyId, scope) });
  });

  r.post('/recurring', async (req, res) => {
    const { member, scope } = ctx(res);
    const b = (req.body ?? {}) as any;
    if (!b.categoryId || typeof b.amount !== 'number' || !(b.amount > 0)) {
      return res.status(400).json({ error: 'categoryId and positive amount required' });
    }
    try {
      const rule = await createRecurringRule(
        {
          familyId: member.familyId,
          memberId: member.id,
          categoryId: b.categoryId,
          amount: b.amount,
          note: b.note,
          isShared: b.isShared,
          frequency: b.frequency as RecurringFreq | undefined,
          dayOfMonth: b.dayOfMonth,
          dayOfWeek: b.dayOfWeek,
          accountId: b.accountId,
          creditCardId: b.creditCardId,
        },
        scope,
      );
      return res.json({ id: rule.id });
    } catch (err) {
      return fail(res, err);
    }
  });

  r.put('/recurring/:id', async (req, res) => {
    const { member, scope } = ctx(res);
    const b = (req.body ?? {}) as any;
    try {
      await updateRecurringRule(
        {
          familyId: member.familyId,
          id: req.params.id,
          categoryId: b.categoryId,
          amount: b.amount,
          note: b.note,
          isShared: b.isShared,
          frequency: b.frequency,
          dayOfMonth: b.dayOfMonth,
          dayOfWeek: b.dayOfWeek,
          accountId: b.accountId,
          creditCardId: b.creditCardId,
          isActive: b.isActive,
        },
        scope,
      );
      return res.json({ ok: true });
    } catch (err) {
      return fail(res, err);
    }
  });

  r.delete('/recurring/:id', async (req, res) => {
    const { member, scope } = ctx(res);
    try {
      await deleteRecurringRule(member.familyId, req.params.id, scope);
      await recordAudit({ familyId: member.familyId, actorMemberId: member.id, channel: 'LIFF', action: 'DELETE', targetType: 'RECURRING', targetId: req.params.id });
      return res.json({ ok: true });
    } catch (err) {
      return fail(res, err);
    }
  });

  // 分類清單（給新增/編輯交易的分類選單）
  r.get('/categories', async (_req, res) => {
    const { member } = ctx(res);
    const cats = await prisma.category.findMany({
      where: { familyId: member.familyId },
      orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }],
      select: { id: true, name: true, icon: true, type: true },
    });
    return res.json({ categories: cats });
  });

  // 手動新增一筆交易（記帳簿表單）— 只能記到共同或自己的帳戶／卡
  r.post('/transactions', async (req, res) => {
    const { member, scope } = ctx(res);
    const b = (req.body ?? {}) as {
      categoryId?: string;
      amount?: number;
      note?: string | null;
      paidAt?: string;
      accountId?: string | null;
      creditCardId?: string | null;
      isShared?: boolean;
    };
    if (!b.categoryId || typeof b.amount !== 'number' || !(b.amount > 0)) {
      return res.status(400).json({ error: 'categoryId and positive amount required' });
    }
    const cat = await prisma.category.findFirst({ where: { id: b.categoryId, familyId: member.familyId } });
    if (!cat) return res.status(400).json({ error: 'invalid categoryId' });
    try {
      if (b.accountId) {
        const a = await prisma.account.findFirst({ where: { id: b.accountId, familyId: member.familyId } });
        if (!a) return res.status(400).json({ error: 'invalid accountId' });
        if (!b.creditCardId) scope.assertAccountWritable(b.accountId);
      }
      if (b.creditCardId) {
        const c = await prisma.creditCard.findFirst({ where: { id: b.creditCardId, familyId: member.familyId } });
        if (!c) return res.status(400).json({ error: 'invalid creditCardId' });
        scope.assertCardWritable(b.creditCardId);
      }
    } catch (err) {
      return fail(res, err);
    }

    const tx = await prisma.transaction.create({
      data: {
        familyId: member.familyId,
        memberId: member.id,
        categoryId: b.categoryId,
        amount: Math.round(b.amount * 100) / 100,
        note: b.note?.trim() || null,
        paidAt: parsePaidAt(b.paidAt) ?? new Date(),
        source: 'MANUAL',
        accountId: b.creditCardId ? null : b.accountId ?? null,
        creditCardId: b.creditCardId ?? null,
        isShared: b.isShared ?? true,
      },
    });
    return res.json({ id: tx.id });
  });

  // 編輯一筆交易 — D10：看不到明細回 404；別人個人帳戶上的回 403；改付款方式時新的也要能寫
  r.patch('/transactions/:id', async (req, res) => {
    const { member, scope } = ctx(res);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    let old: Awaited<ReturnType<typeof getWritableTransaction>>;
    try {
      old = await getWritableTransaction(scope, req.params.id);

      if (typeof b.categoryId === 'string') {
        const cat = await prisma.category.findFirst({ where: { id: b.categoryId, familyId: member.familyId } });
        if (!cat) return res.status(400).json({ error: 'invalid categoryId' });
        data.categoryId = b.categoryId;
      }
      if (typeof b.amount === 'number' && b.amount > 0) data.amount = Math.round(b.amount * 100) / 100;
      if (b.note !== undefined) data.note = (b.note as string)?.trim() || null;
      if (typeof b.isShared === 'boolean') data.isShared = b.isShared;
      const pa = parsePaidAt(b.paidAt);
      if (pa) data.paidAt = pa;
      // 付款方式：accountId 與 creditCardId 二擇一（給其一就清掉另一）
      if (b.creditCardId !== undefined) {
        if (b.creditCardId) {
          const c = await prisma.creditCard.findFirst({ where: { id: b.creditCardId as string, familyId: member.familyId } });
          if (!c) return res.status(400).json({ error: 'invalid creditCardId' });
          scope.assertCardWritable(c.id);
          data.creditCardId = b.creditCardId;
          data.accountId = null;
        } else {
          data.creditCardId = null;
        }
      }
      if (b.accountId !== undefined) {
        if (b.accountId) {
          const a = await prisma.account.findFirst({ where: { id: b.accountId as string, familyId: member.familyId } });
          if (!a) return res.status(400).json({ error: 'invalid accountId' });
          scope.assertAccountWritable(a.id);
          data.accountId = b.accountId;
          data.creditCardId = null;
        } else if (data.creditCardId === undefined) {
          data.accountId = null;
        }
      }
    } catch (err) {
      return fail(res, err);
    }

    await prisma.$transaction([
      prisma.transaction.update({ where: { id: req.params.id }, data }),
      auditCreateOp({
        familyId: member.familyId,
        actorMemberId: member.id,
        channel: 'LIFF',
        action: 'EDIT',
        targetType: 'TRANSACTION',
        targetId: req.params.id,
        subjectMemberId: txSubject(scope, old) ?? txSubject(scope, data as { accountId?: string | null; creditCardId?: string | null }),
        detail: { fields: Object.keys(data) },
      }),
    ]);
    return res.json({ ok: true });
  });

  // 刪除一筆交易 — D10
  r.delete('/transactions/:id', async (req, res) => {
    const { member, scope } = ctx(res);
    let old: Awaited<ReturnType<typeof getWritableTransaction>>;
    try {
      old = await getWritableTransaction(scope, req.params.id);
    } catch (err) {
      return fail(res, err);
    }
    await prisma.$transaction([
      prisma.transaction.delete({ where: { id: req.params.id } }),
      auditCreateOp({
        familyId: member.familyId,
        actorMemberId: member.id,
        channel: 'LIFF',
        action: 'DELETE',
        targetType: 'TRANSACTION',
        targetId: req.params.id,
        subjectMemberId: txSubject(scope, old),
        detail: { amount: Number(old.amount), paidAt: old.paidAt.toISOString().slice(0, 10) },
      }),
    ]);
    return res.json({ ok: true });
  });

  // CSV 匯出（Excel 可開，加 UTF-8 BOM 避免中文亂碼）— 只匯出看得到明細的
  r.get('/export', async (req, res) => {
    const { member, scope } = ctx(res);
    const month = resolveMonth(req.query.month);
    const items = await getMonthlyTransactions(member.familyId, month, scope);
    // 匯出一定要先記到稽核才給檔案（fail-closed）；連帶記「看到了誰的個人明細」（每次都記，不去重）
    try {
      await writeAudit({ familyId: member.familyId, actorMemberId: member.id, channel: 'LIFF', action: 'EXPORT_CSV', targetType: 'EXPORT', detail: { month, rows: items.length } });
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'export audit failed');
      return res.status(503).json({ error: 'audit unavailable', code: 'audit_unavailable' });
    }
    await recordPersonalViews({ scope, channel: 'LIFF', targetType: 'EXPORT', owners: items.map((t) => txSubject(scope, t)), detail: { month }, dedupe: false });

    // 每一格走 lib/csv.ts（MED-2 防公式注入：=HYPERLINK 之類加 '、字串一律加引號、金額數字不動）
    const csv = ledgerExportCsv(items);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ledger-${month}.csv"`);
    return res.send(csv);
  });

  // ===== 稽核紀錄（P0-4）：mine＝別人看過／動過我的東西；family＝共同的＋跟我有關的 =====
  r.get('/audit-log', async (req, res) => {
    const { member } = ctx(res);
    const kind = req.query.scope === 'family' ? 'family' : 'mine';
    const limit = Number(req.query.limit) || 100;
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ scope: kind, items: await listAuditForMember(member.familyId, member.id, kind, limit) });
  });

  // ===== 真實姓名（帳單戶名，D12）：只有本人；只回遮罩 =====
  r.get('/me/legal-name', async (_req, res) => {
    const { member } = ctx(res);
    res.setHeader('Cache-Control', 'no-store');
    return res.json(await getLegalNameStatus(member.id));
  });

  // body: { legalName: string | null }（null 或空字串＝清除）。金鑰不可用 → 503，不寫入
  r.put('/me/legal-name', async (req, res) => {
    const { member } = ctx(res);
    res.setHeader('Cache-Control', 'no-store');
    try {
      return res.json(await setLegalName({ familyId: member.familyId, memberId: member.id, value: (req.body ?? {}).legalName ?? null, channel: 'LIFF' }));
    } catch (err) {
      if (err instanceof FieldKeyError) {
        logger.error({ reason: err.message }, 'legal name write blocked: field key unavailable');
        return res.status(503).json({ error: 'encryption key unavailable', code: err.code });
      }
      if (err instanceof LegalNameInputError) return res.status(400).json({ error: err.message, code: 'invalid_legal_name' });
      throw err;
    }
  });

  return r;
}

// 所有 /api/liff/* 先過 LIFF ID token 驗證（Authorization: Bearer <liff.getIDToken()>）。
// 不再採信前端自報的 userId header；userId 一律取 LINE verify 回傳的 sub。
const loginChannel = resolveLoginChannelId(process.env);
if (loginChannel.source !== 'env') {
  logger.warn({ channelId: loginChannel.channelId }, 'LINE_LOGIN_CHANNEL_ID 未設，改用 LINE_LIFF_ID 前綴當 LIFF 所屬 Login channel id');
}
export const liffRouter = buildLiffRouter(
  createLiffAuth({
    channelId: loginChannel.channelId,
    onVerifyError: (detail) => logger.error({ detail }, 'LINE ID token verify unavailable'),
  }),
);
