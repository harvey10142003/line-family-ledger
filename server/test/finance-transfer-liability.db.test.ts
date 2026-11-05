// 轉帳引擎（P1-4）與負債（P1-3）：走真的 /api/liff/* 路由＋真的 PostgreSQL。
//
// 需要拋棄式本機資料庫（已 prisma db push 過），同 access-matrix.db.test.ts：
//   LEDGER_TEST_DATABASE_URL=postgresql://user@127.0.0.1:5432/ledger_test npm --workspace server test
// 沒設就整支跳過。只接受 127.0.0.1／localhost。
//
// 不變式（規格 7.2 P1-4 驗收）：
// - 任何轉帳都不改變家庭當月收入與支出（連帶的利息、手續費除外）
// - 家庭淨資產（帳戶餘額＋借出－借入）只會因連帶的利息、手續費而變；夫妻互轉家庭淨資產不變、只動兩人各自的
// - 撤銷後餘額、帳單已繳金額、負債剩餘本金完全還原
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';

const DB_URL = process.env.LEDGER_TEST_DATABASE_URL ?? '';
const SKIP = !DB_URL ? 'LEDGER_TEST_DATABASE_URL 未設（需要本機拋棄式 PostgreSQL）' : false;
if (DB_URL && !/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(DB_URL)) {
  throw new Error('LEDGER_TEST_DATABASE_URL 只能指向 127.0.0.1／localhost 的測試庫');
}

const CHANNEL = '1234567890';
const RUN = randomBytes(4).toString('hex');
const FAM = `famT_${RUN}`;
const SHARK = `msT_${RUN}`;
const APPLE = `maT_${RUN}`;
const MONTH = '2026-10';
const DAY = '2026-10-20';

let prisma: any;
let base = '';
let server: any;
const A: Record<string, string> = {}; // 帳戶
let cardId = '';
let stmtId = '';
let loanId = '';

async function call(who: 'shark' | 'apple', method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api/liff${path}`, {
    method,
    headers: { authorization: `Bearer tok-${who}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json };
}

before(async () => {
  if (SKIP) return;
  process.env.DATABASE_URL = DB_URL;
  process.env.LINE_LOGIN_CHANNEL_ID = CHANNEL;
  process.env.LINE_CHANNEL_SECRET ??= 'test-secret';
  process.env.LINE_CHANNEL_ACCESS_TOKEN ??= 'test-token';
  process.env.LINE_LIFF_ID ??= `${CHANNEL}-test`;
  process.env.GEMINI_API_KEY ??= 'test-gemini';

  ({ prisma } = await import('../src/prisma'));
  const { buildLiffRouter } = await import('../src/routes/liff');
  const { createLiffAuth } = await import('../src/lib/liff-auth');
  const subs: Record<string, string> = { 'tok-shark': `UT_shark_${RUN}`, 'tok-apple': `UT_apple_${RUN}` };
  const fakeFetch = (async (_url: any, init?: any) => {
    const sub = subs[new URLSearchParams(String(init?.body ?? '')).get('id_token') ?? ''];
    const json = sub ? { sub, aud: CHANNEL, exp: Math.floor(Date.now() / 1000) + 3600 } : { error: 'invalid_request' };
    return new Response(JSON.stringify(json), { status: sub ? 200 : 400, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/liff', buildLiffRouter(createLiffAuth({ channelId: CHANNEL, fetchImpl: fakeFetch })));
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await prisma.family.create({ data: { id: FAM, name: '轉帳測試家', familyCode: RUN.slice(0, 6).toUpperCase(), ownerLineId: subs['tok-shark'] } });
  await prisma.familyMember.createMany({
    data: [
      { id: SHARK, familyId: FAM, lineUserId: subs['tok-shark'], displayName: 'Shark', role: 'OWNER' },
      { id: APPLE, familyId: FAM, lineUserId: subs['tok-apple'], displayName: 'Apple', role: 'MEMBER' },
    ],
  });
  await prisma.category.create({ data: { familyId: FAM, name: '餐飲', type: 'EXPENSE', isDefault: true, sortOrder: 1 } });
  const accs: [string, string, any, number, string | null, string][] = [
    ['bank', '共同銀行', 'BANK', 100000, null, 'FAMILY_FULL'],
    ['cash', '現金', 'CASH', 5000, null, 'FAMILY_FULL'],
    ['td', '將來定存', 'TIME_DEPOSIT', 0, null, 'FAMILY_FULL'],
    ['wallet', '電子錢包', 'EPAYMENT', 0, null, 'FAMILY_FULL'],
    ['shark', 'Shark 台新', 'BANK', 50000, SHARK, 'FAMILY_TOTAL_ONLY'],
    ['apple', 'Apple 臺銀', 'BANK', 30000, APPLE, 'FAMILY_TOTAL_ONLY'],
    ['appleSecret', 'Apple 私房', 'BANK', 7000, APPLE, 'OWNER_ONLY'],
  ];
  for (const [k, name, type, opening, owner, vis] of accs) {
    const a = await prisma.account.create({
      data: { familyId: FAM, name, type, openingBalance: opening, isDefault: k === 'bank', ...(owner ? { ownerMemberId: owner, visibility: vis } : {}) },
    });
    A[k] = a.id;
  }
  const card = await prisma.creditCard.create({ data: { familyId: FAM, name: '國泰卡', creditLimit: 100000, statementDay: 5, dueDay: 20 } });
  cardId = card.id;
  const st = await call('shark', 'POST', `/credit-cards/${cardId}/statements`, { statementDate: '2026-10-05', dueDate: '2099-10-20', newBalance: 24261, minimumDue: 2426 });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  stmtId = st.json.id;
  const loan = await call('shark', 'POST', '/liabilities', {
    name: '房貸',
    kind: 'MORTGAGE',
    direction: 'BORROWED',
    lender: '玉山',
    principal: 1000000,
    annualRate: 2,
    termMonths: 240,
    startDate: '2026-01-10',
    method: 'EQUAL_PAYMENT',
  });
  assert.equal(loan.status, 200, JSON.stringify(loan.json));
  loanId = loan.json.id;
});

after(async () => {
  if (SKIP) return;
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.transfer.deleteMany({ where: { familyId: FAM } });
  await prisma.liability.deleteMany({ where: { familyId: FAM } });
  await prisma.transaction.deleteMany({ where: { familyId: FAM } });
  await prisma.cardStatement.deleteMany({ where: { familyId: FAM } });
  await prisma.account.deleteMany({ where: { familyId: FAM } });
  await prisma.creditCard.deleteMany({ where: { familyId: FAM } });
  await prisma.category.deleteMany({ where: { familyId: FAM } });
  await prisma.familyMember.deleteMany({ where: { familyId: FAM } });
  await prisma.family.delete({ where: { id: FAM } });
  await prisma.$disconnect();
});

type Snap = {
  income: number;
  expense: number;
  balances: Record<string, number>;
  liabilities: Record<string, number>;
  borrowed: number;
  lent: number;
  net: number; // 家庭淨資產（以這位成員看得到的範圍）＝帳戶餘額＋借出－借入－信用卡已出帳未繳（溢繳算負的欠款）
  byOwner: Record<string, number>; // 各成員個人帳戶餘額合計（共同＝'joint'）
  stmt: { paidAmount: number; status: string };
};

async function snap(who: 'shark' | 'apple' = 'shark'): Promise<Snap> {
  const [sum, accs, lia, stmts] = await Promise.all([
    call(who, 'GET', `/summary?month=${MONTH}`),
    call(who, 'GET', '/accounts'),
    call(who, 'GET', '/liabilities'),
    call(who, 'GET', `/credit-cards/${cardId}/statements`),
  ]);
  const balances: Record<string, number> = {};
  const byOwner: Record<string, number> = {};
  for (const a of accs.json.accounts) {
    balances[a.id] = a.balance;
    const k = a.ownerMemberId ?? 'joint';
    byOwner[k] = Math.round(((byOwner[k] ?? 0) + a.balance) * 100) / 100;
  }
  const liabilities: Record<string, number> = {};
  for (const l of lia.json.items) liabilities[l.id] = l.currentPrincipal;
  const accTotal = Object.values(balances).reduce((s, x) => s + x, 0);
  const s = stmts.json.items.find((x: any) => x.id === stmtId);
  const cardOwed = stmts.json.items.reduce((sum: number, x: any) => sum + x.newBalance - x.paidAmount, 0);
  return {
    income: sum.json.totalIncome,
    expense: sum.json.totalExpense,
    balances,
    liabilities,
    borrowed: lia.json.totals.borrowed,
    lent: lia.json.totals.lent,
    net: Math.round((accTotal + lia.json.totals.net - cardOwed) * 100) / 100,
    byOwner,
    stmt: { paidAmount: s.paidAmount, status: s.status },
  };
}

// 轉帳後收支、淨資產只因連帶利息／手續費而變；撤銷後全部回到原樣（新借出入對象的剩餘本金回 0）
async function checkInvariant(
  label: string,
  who: 'shark' | 'apple',
  body: Record<string, unknown>,
  linked: { income?: number; expense?: number },
  extra?: (before: Snap, after: Snap, res: any) => void | Promise<void>,
) {
  const b = await snap();
  const res = await call(who, 'POST', '/transfers', { transferredAt: DAY, ...body });
  assert.equal(res.status, 200, `${label}: ${JSON.stringify(res.json)}`);
  const a = await snap();
  const inc = linked.income ?? 0;
  const exp = linked.expense ?? 0;
  assert.equal(Math.round((a.income - b.income) * 100) / 100, inc, `${label} 收入只變連帶利息收入`);
  assert.equal(Math.round((a.expense - b.expense) * 100) / 100, exp, `${label} 支出只變連帶利息／手續費`);
  assert.equal(Math.round((a.net - b.net) * 100) / 100, Math.round((inc - exp) * 100) / 100, `${label} 淨資產只變連帶收支`);
  if (extra) await extra(b, a, res.json);

  // 撤銷 → 完全還原
  const u = await call(who, 'POST', `/transfers/${res.json.id}/undo`);
  assert.equal(u.status, 200, `${label} undo: ${JSON.stringify(u.json)}`);
  const r = await snap();
  assert.deepEqual(r.balances, b.balances, `${label} 撤銷後餘額還原`);
  assert.equal(r.income, b.income, `${label} 撤銷後收入還原`);
  assert.equal(r.expense, b.expense, `${label} 撤銷後支出還原`);
  assert.deepEqual(r.stmt, b.stmt, `${label} 撤銷後帳單已繳還原`);
  for (const [id, v] of Object.entries(b.liabilities)) assert.equal(r.liabilities[id], v, `${label} 撤銷後負債本金還原`);
  for (const [id, v] of Object.entries(r.liabilities)) if (!(id in b.liabilities)) assert.equal(v, 0, `${label} 新建對象撤銷後歸 0`);
  assert.equal(r.net, b.net, `${label} 撤銷後淨資產還原`);
  return res.json;
}

test('不變式：3.10.1 每一種轉帳都不算收支、撤銷後完全還原（真路由＋真 PG）', { skip: SKIP }, async () => {
  await checkInvariant('一般轉帳', 'shark', { kind: 'ACCOUNT', fromAccountId: A.bank, toAccountId: A.shark, amount: 1000 }, {}, (b, a) => {
    assert.equal(a.balances[A.bank] - b.balances[A.bank], -1000);
    assert.equal(a.balances[A.shark] - b.balances[A.shark], 1000);
  });
  await checkInvariant('舊表單（不帶 kind）', 'shark', { fromAccountId: A.bank, toAccountId: A.cash, amount: 200 }, {}, (_b, _a, res) => {
    assert.equal(res.kind, 'ACCOUNT');
  });
  await checkInvariant('提領現金＋跨行手續費 15', 'shark', { kind: 'CASH_WITHDRAW', fromAccountId: A.bank, toAccountId: A.cash, amount: 3000, fee: 15 }, { expense: 15 }, (b, a, res) => {
    assert.equal(a.balances[A.bank] - b.balances[A.bank], -3015);
    assert.equal(a.balances[A.cash] - b.balances[A.cash], 3000);
    assert.equal(res.linkedTransactionIds.length, 1);
  });
  await checkInvariant('存入現金', 'shark', { kind: 'CASH_DEPOSIT', fromAccountId: A.cash, toAccountId: A.bank, amount: 500 }, {});
  await checkInvariant('轉定存', 'shark', { kind: 'TIME_DEPOSIT', fromAccountId: A.bank, toAccountId: A.td, amount: 20000 }, {});
  await checkInvariant('定存到期＋利息收入 120', 'shark', { kind: 'TIME_DEPOSIT', fromAccountId: A.td, toAccountId: A.bank, amount: 20000, interest: 120 }, { income: 120 }, (b, a) => {
    assert.equal(a.balances[A.bank] - b.balances[A.bank], 20120);
  });
  await checkInvariant('繳卡費全額', 'shark', { kind: 'CARD_PAYMENT', fromAccountId: A.bank, toCreditCardId: cardId, amount: 24261 }, {}, (b, a, res) => {
    assert.equal(a.balances[A.bank] - b.balances[A.bank], -24261);
    assert.deepEqual(a.stmt, { paidAmount: 24261, status: 'PAID' });
    assert.equal(res.statement.status, 'PAID');
  });
  await checkInvariant('繳卡費部分', 'shark', { kind: 'CARD_PAYMENT', fromAccountId: A.bank, toCreditCardId: cardId, amount: 10000 }, {}, (_b, a, res) => {
    assert.deepEqual(a.stmt, { paidAmount: 10000, status: 'PARTIAL' });
    assert.equal(res.statement.remaining, 14261);
  });
  await checkInvariant('繳卡費溢繳（確認後）', 'shark', { kind: 'CARD_PAYMENT', fromAccountId: A.bank, toCreditCardId: cardId, amount: 25000, confirmOverpay: true }, {}, (_b, a, res) => {
    assert.deepEqual(a.stmt, { paidAmount: 25000, status: 'PAID' });
    assert.equal(res.statement.overpaid, 739);
  });
  await checkInvariant(
    '還房貸 18000＝本金 12000＋利息 6000',
    'shark',
    { kind: 'LOAN_REPAY', fromAccountId: A.bank, toLiabilityId: loanId, amount: 12000, interest: 6000, total: 18000 },
    { expense: 6000 },
    async (b, a, res) => {
      assert.equal(a.balances[A.bank] - b.balances[A.bank], -18000);
      assert.equal(a.liabilities[loanId] - b.liabilities[loanId], -12000);
      const pays = await call('shark', 'GET', `/liabilities/${loanId}/payments`);
      const p = pays.json.items.find((x: any) => x.transferId === res.id);
      assert.deepEqual([p.total, p.principalPart, p.interestPart, p.feePart, p.undone], [18000, 12000, 6000, 0, false]);
    },
  );
  const lend = await checkInvariant('借小明 5000（新建借出對象）', 'shark', { kind: 'LEND', fromAccountId: A.bank, newLiability: { name: '借小明' }, amount: 5000 }, {}, (b, a, res) => {
    assert.equal(a.lent - b.lent, 5000, '借出記成資產');
    assert.equal(a.liabilities[res.liabilityId], 5000);
  });
  // 撤銷後的「借小明」留著（本金 0），再借一次用既有對象
  await checkInvariant('借出到既有對象', 'shark', { kind: 'LEND', fromAccountId: A.bank, toLiabilityId: lend.liabilityId, amount: 5000 }, {});
  const lent = await call('shark', 'POST', '/transfers', { kind: 'LEND', fromAccountId: A.bank, toLiabilityId: lend.liabilityId, amount: 5000, transferredAt: DAY });
  assert.equal(lent.status, 200);
  await checkInvariant('小明還我 2000＋約定利息 50', 'shark', { kind: 'COLLECT', fromLiabilityId: lend.liabilityId, toAccountId: A.bank, amount: 2000, interest: 50 }, { income: 50 }, (b, a) => {
    assert.equal(a.liabilities[lend.liabilityId], 3000);
    assert.equal(a.balances[A.bank] - b.balances[A.bank], 2050);
  });
  await checkInvariant('跟阿姨借 10000（新建負債）', 'shark', { kind: 'BORROW', newLiability: { name: '阿姨' }, toAccountId: A.bank, amount: 10000 }, {}, (b, a) => {
    assert.equal(a.borrowed - b.borrowed, 10000);
    assert.equal(a.balances[A.bank] - b.balances[A.bank], 10000);
  });
  await checkInvariant('夫妻互轉：Apple 轉 1 萬給 Shark', 'apple', { kind: 'SPOUSE', fromAccountId: A.apple, toAccountId: A.shark, amount: 10000 }, {}, (b, a) => {
    // 家庭淨資產不變（上面 checkInvariant 已驗），只動兩人各自的
    assert.equal(a.byOwner[APPLE] - b.byOwner[APPLE], -10000);
    assert.equal(a.byOwner[SHARK] - b.byOwner[SHARK], 10000);
    assert.equal(a.byOwner.joint, b.byOwner.joint);
  });
});

test('拒絕：組合不合法、利息不該出現、拆分對不上、超過剩餘本金、溢繳沒確認、動到對方個人帳戶', { skip: SKIP }, async () => {
  const before = await snap();
  const bad = async (who: 'shark' | 'apple', body: any, status: number, code?: string) => {
    const r = await call(who, 'POST', '/transfers', { transferredAt: DAY, ...body });
    assert.equal(r.status, status, `${JSON.stringify(body)} → ${JSON.stringify(r.json)}`);
    if (code) assert.equal(r.json.code, code);
    return r;
  };
  await bad('shark', { kind: 'CASH_WITHDRAW', fromAccountId: A.cash, toAccountId: A.bank, amount: 100 }, 400, 'invalid_shape');
  await bad('shark', { kind: 'SPOUSE', fromAccountId: A.bank, toAccountId: A.shark, amount: 100 }, 400, 'invalid_shape');
  await bad('shark', { kind: 'ACCOUNT', fromAccountId: A.bank, toAccountId: A.cash, amount: 100, interest: 5 }, 400, 'interest_not_allowed');
  await bad('shark', { kind: 'LOAN_REPAY', fromAccountId: A.bank, toLiabilityId: loanId, amount: 12000, interest: 5000, total: 18000 }, 400, 'split_mismatch');
  await bad('shark', { kind: 'LOAN_REPAY', fromAccountId: A.bank, toLiabilityId: loanId, amount: 2_000_000 }, 400, 'exceeds_principal');
  const op = await bad('shark', { kind: 'CARD_PAYMENT', fromAccountId: A.bank, toCreditCardId: cardId, amount: 25000 }, 409, 'overpay_needs_confirm');
  assert.equal(op.json.detail.overpaid, 739);
  await bad('shark', { kind: 'ACCOUNT', fromAccountId: A.bank, toAccountId: A.cash, amount: 0 }, 400, 'invalid_amount');
  await bad('shark', { kind: 'NOPE', fromAccountId: A.bank, toAccountId: A.cash, amount: 1 }, 400, 'invalid_kind');
  await bad('shark', { kind: 'ACCOUNT', fromAccountId: A.bank, toAccountId: A.cash, toCreditCardId: cardId, amount: 1 }, 400, 'invalid_shape');
  // D10／D18：Shark 不能從 Apple 的個人帳戶轉出（只看總額 → 403；完全看不到 → 404）
  await bad('shark', { kind: 'SPOUSE', fromAccountId: A.apple, toAccountId: A.shark, amount: 10000 }, 403, 'not_owner');
  await bad('shark', { kind: 'ACCOUNT', fromAccountId: A.appleSecret, toAccountId: A.bank, amount: 1 }, 404, 'not_found');
  await bad('shark', { kind: 'ACCOUNT', fromAccountId: A.bank, toAccountId: A.appleSecret, amount: 1 }, 404, 'not_found');
  // 不能在對方的個人帳戶上記連帶收支：收回借款到 Apple 帳戶並帶利息
  const xiao = await call('shark', 'POST', '/transfers', { kind: 'LEND', fromAccountId: A.bank, newLiability: { name: '借阿明' }, amount: 300, transferredAt: DAY });
  await bad('shark', { kind: 'COLLECT', fromLiabilityId: xiao.json.liabilityId, toAccountId: A.apple, amount: 100, interest: 1 }, 403, 'not_owner');
  await call('shark', 'POST', `/transfers/${xiao.json.id}/undo`);
  // 失敗的請求一律沒有留下任何變動
  const afterAll = await snap();
  assert.deepEqual(afterAll.balances, before.balances);
  assert.deepEqual(afterAll.stmt, before.stmt);
  assert.equal(afterAll.liabilities[loanId], before.liabilities[loanId]);
  assert.equal(afterAll.expense, before.expense);
});

test('撤銷只有建立者能按、不能撤兩次；撤銷不刪資料；對帳狀態可切換', { skip: SKIP }, async () => {
  const r = await call('shark', 'POST', '/transfers', { kind: 'ACCOUNT', fromAccountId: A.bank, toAccountId: A.cash, amount: 77, transferredAt: DAY, note: '撤銷測試' });
  assert.equal(r.status, 200);
  assert.equal(r.json.canUndo, true);
  const byApple = await call('apple', 'POST', `/transfers/${r.json.id}/undo`);
  assert.equal(byApple.status, 403);
  assert.equal(byApple.json.code, 'not_creator');
  const rec = await call('apple', 'PATCH', `/transfers/${r.json.id}/reconcile`, { reconcileStatus: 'RECONCILED' });
  assert.equal(rec.status, 200, '共同帳戶之間的轉帳，家人也能標對帳');
  assert.equal(rec.json.reconcileStatus, 'RECONCILED');
  assert.equal((await call('shark', 'PATCH', `/transfers/${r.json.id}/reconcile`, { reconcileStatus: 'X' })).status, 400);
  assert.equal((await call('shark', 'POST', `/transfers/${r.json.id}/undo`)).status, 200);
  const again = await call('shark', 'POST', `/transfers/${r.json.id}/undo`);
  assert.equal(again.status, 409);
  const row = await prisma.transfer.findUnique({ where: { id: r.json.id } });
  assert.ok(row && row.undoneAt && row.undoneByMemberId === SHARK, '撤銷只標記，不刪');
  const list = await call('shark', 'GET', `/transfers?month=${MONTH}`);
  const item = list.json.items.find((x: any) => x.id === r.json.id);
  assert.deepEqual([item.undone, item.canUndo, item.kindLabel, item.reconcileStatus], [true, false, '轉帳', 'RECONCILED']);
});

test('轉帳列表：Apple 看不到 Shark 只看總額帳戶→不公開負債的還款；目的是卡、負債時名稱正確', { skip: SKIP }, async () => {
  const secretLoan = await call('shark', 'POST', '/liabilities', { name: 'Shark 信貸', principal: 100000, ownerMemberId: SHARK, visibility: 'OWNER_ONLY' });
  assert.equal(secretLoan.status, 200);
  const t1 = await call('shark', 'POST', '/transfers', { kind: 'LOAN_REPAY', fromAccountId: A.shark, toLiabilityId: secretLoan.json.id, amount: 1000, transferredAt: DAY });
  const t2 = await call('shark', 'POST', '/transfers', { kind: 'LOAN_REPAY', fromAccountId: A.bank, toLiabilityId: secretLoan.json.id, amount: 1000, transferredAt: DAY });
  const t3 = await call('shark', 'POST', '/transfers', { kind: 'CARD_PAYMENT', fromAccountId: A.bank, toCreditCardId: cardId, amount: 100, transferredAt: DAY });
  for (const t of [t1, t2, t3]) assert.equal(t.status, 200, JSON.stringify(t.json));
  const apple = await call('apple', 'GET', `/transfers?month=${MONTH}`);
  assert.equal(apple.json.items.some((x: any) => x.id === t1.json.id), false);
  const a2 = apple.json.items.find((x: any) => x.id === t2.json.id);
  assert.deepEqual([a2.fromName, a2.toName], ['共同銀行', '不公開帳戶']);
  const a3 = apple.json.items.find((x: any) => x.id === t3.json.id);
  assert.deepEqual([a3.kind, a3.toName], ['CARD_PAYMENT', '國泰卡']);
  const shark = await call('shark', 'GET', `/transfers?month=${MONTH}`);
  assert.equal(shark.json.items.find((x: any) => x.id === t2.json.id).toName, 'Shark 信貸');
  // Apple 看不到這筆負債，也就不能還它、不能撤銷
  assert.equal((await call('apple', 'POST', '/transfers', { kind: 'LOAN_REPAY', fromAccountId: A.bank, toLiabilityId: secretLoan.json.id, amount: 1, transferredAt: DAY })).status, 404);
  assert.equal((await call('apple', 'POST', `/transfers/${t1.json.id}/undo`)).status, 404);
  for (const t of [t1, t2, t3]) await call('shark', 'POST', `/transfers/${t.json.id}/undo`);
});

test('負債：攤還表、利率變動重算、建議拆法、可見範圍與編輯權限、借出算資產', { skip: SKIP }, async () => {
  const sch = await call('shark', 'GET', `/liabilities/${loanId}/schedule`);
  assert.equal(sch.status, 200);
  assert.equal(sch.json.rows.length, 240);
  assert.deepEqual([sch.json.rows[0].payment, sch.json.rows[0].interest, sch.json.rows[0].principal], [5059, 1667, 3392]);

  const rc = await call('shark', 'POST', `/liabilities/${loanId}/rate-changes`, { effectiveDate: '2027-01-01', annualRate: 2.5 });
  assert.equal(rc.status, 200, JSON.stringify(rc.json));
  // 第一次改利率時，原利率補記成第一筆歷程
  assert.deepEqual(rc.json.rateChanges, [
    { effectiveDate: '2026-01-10', annualRate: 2 },
    { effectiveDate: '2027-01-01', annualRate: 2.5 },
  ]);
  const sch2 = await call('shark', 'GET', `/liabilities/${loanId}/schedule`);
  assert.deepEqual(sch2.json.rows.slice(0, 12), sch.json.rows.slice(0, 12), '生效前不變');
  assert.deepEqual([sch2.json.rows[12].annualRatePct, sch2.json.rows[12].interest, sch2.json.rows[12].payment], [2.5, 1998, 5288]);
  assert.equal(sch2.json.rows[239].balance, 0);

  const sp = await call('shark', 'GET', `/liabilities/${loanId}/suggest-split?total=18000&date=2026-11-10`);
  assert.equal(sp.status, 200);
  // 剩 1,000,000（測試前面的還款都撤銷了）× 2%/12 = 1,666.67 → 1,667；其餘本金
  assert.deepEqual([sp.json.interest, sp.json.principal, sp.json.annualRate], [1667, 16333, 2]);

  // 可見範圍：Shark 個人「只看總額」的負債，Apple 只看到剩餘本金，看不到攤還表、不能改
  const mine = await call('shark', 'POST', '/liabilities', {
    name: 'Shark 車貸',
    kind: 'CAR',
    principal: 600000,
    annualRate: 3,
    termMonths: 60,
    startDate: '2026-02-01',
    method: 'EQUAL_PRINCIPAL',
    ownerMemberId: SHARK,
  });
  assert.equal(mine.status, 200, JSON.stringify(mine.json));
  const appleList = await call('apple', 'GET', '/liabilities');
  const seen = appleList.json.items.find((x: any) => x.id === mine.json.id);
  assert.ok(seen, 'Apple 看得到總額');
  assert.equal(seen.access, 'TOTAL');
  assert.equal(seen.currentPrincipal, 600000);
  assert.equal(seen.annualRate, undefined, '只看總額看不到利率');
  assert.equal(seen.canEdit, false);
  assert.equal((await call('apple', 'GET', `/liabilities/${mine.json.id}/schedule`)).status, 404);
  assert.equal((await call('apple', 'PUT', `/liabilities/${mine.json.id}`, { name: '改名' })).status, 403);
  assert.equal((await call('apple', 'POST', `/liabilities/${mine.json.id}/rate-changes`, { effectiveDate: '2027-01-01', annualRate: 1 })).status, 403);
  // 不能把負債建成別人的
  assert.equal((await call('apple', 'POST', '/liabilities', { name: 'x', principal: 1, ownerMemberId: SHARK })).status, 403);
  // Shark 看得到明細（下一期、預期剩餘本金、還清日）
  const sharkList = await call('shark', 'GET', '/liabilities');
  const full = sharkList.json.items.find((x: any) => x.id === mine.json.id);
  assert.equal(full.payoffDate, '2031-01-01');
  assert.equal(full.nextPayment.principal, 10000);
  assert.equal(typeof full.expectedPrincipal, 'number');
  // 參數不合理
  assert.equal((await call('shark', 'POST', '/liabilities', { name: '壞的', principal: 1000, method: 'EQUAL_PAYMENT' })).status, 400);
  assert.equal((await call('shark', 'POST', '/liabilities', { name: '壞的', principal: 1000, method: 'EQUAL_PAYMENT', annualRate: 2, termMonths: 12, gracePeriodMonths: 12, startDate: '2026-01-01' })).status, 400);

  // 借出記成資產：合計 net＝借出－借入
  const lentBefore = (await call('shark', 'GET', '/liabilities')).json.totals;
  const l = await call('shark', 'POST', '/liabilities', { name: '借表弟', direction: 'LENT', kind: 'FAMILY', principal: 8000 });
  assert.equal(l.status, 200);
  const lentAfter = (await call('shark', 'GET', '/liabilities')).json.totals;
  assert.equal(lentAfter.lent - lentBefore.lent, 8000);
  assert.equal(lentAfter.net - lentBefore.net, 8000);
  // 封存後不算進合計
  assert.equal((await call('shark', 'PUT', `/liabilities/${l.json.id}`, { isArchived: true })).status, 200);
  assert.equal((await call('shark', 'GET', '/liabilities')).json.totals.lent, lentBefore.lent);
});

test('信用卡帳單：同卡同結帳日只有一列（重送＝更新）；家人個人卡不能建帳單', { skip: SKIP }, async () => {
  const again = await call('shark', 'POST', `/credit-cards/${cardId}/statements`, { statementDate: '2026-10-05', dueDate: '2099-10-20', newBalance: 24300 });
  assert.equal(again.status, 200);
  assert.equal(again.json.id, stmtId);
  assert.equal(again.json.newBalance, 24300);
  const rows = await prisma.cardStatement.count({ where: { cardId } });
  assert.equal(rows, 1);
  await call('shark', 'POST', `/credit-cards/${cardId}/statements`, { statementDate: '2026-10-05', dueDate: '2099-10-20', newBalance: 24261 });
  const appleCard = await prisma.creditCard.create({ data: { familyId: FAM, name: 'Apple 卡', ownerMemberId: APPLE, visibility: 'FAMILY_FULL' } });
  assert.equal((await call('shark', 'POST', `/credit-cards/${appleCard.id}/statements`, { statementDate: '2026-10-05', dueDate: '2026-10-25', newBalance: 1 })).status, 403);
  // 但從自己能動的帳戶繳家人的卡可以（錢從自己這邊出）
  await call('apple', 'POST', `/credit-cards/${appleCard.id}/statements`, { statementDate: '2026-10-05', dueDate: '2099-10-25', newBalance: 1000 });
  const pay = await call('shark', 'POST', '/transfers', { kind: 'CARD_PAYMENT', fromAccountId: A.bank, toCreditCardId: appleCard.id, amount: 1000, transferredAt: DAY });
  assert.equal(pay.status, 200, JSON.stringify(pay.json));
  assert.equal(pay.json.statement.status, 'PAID');
  await call('shark', 'POST', `/transfers/${pay.json.id}/undo`);
});
