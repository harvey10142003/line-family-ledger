// P1-5／P1-6／P1-7：LINE 文字記帳＋一句話建轉帳（含 D18 對方確認）＋淨資產快照與全貌，走真的 handler／路由＋真的 PostgreSQL。
//
//   LEDGER_TEST_DATABASE_URL=postgresql://user@127.0.0.1:5432/ledger_test npm --workspace server test
// 沒設就整支跳過。只接受 127.0.0.1／localhost。
// LINE 回覆／推播換成記錄器（不打 LINE），Gemini 換成「這句應該回什麼」的對照表（不打 Gemini）。
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
const FAM = `famN_${RUN}`;
const SHARK = `msN_${RUN}`;
const APPLE = `maN_${RUN}`;
const U_SHARK = `UN_shark_${RUN}`;
const U_APPLE = `UN_apple_${RUN}`;

let prisma: any;
let base = '';
let server: any;
let handleTextMessage: any;
let handlePostback: any;
let notifyExpiredTransfers: any;
let setHooks: any;
const A: Record<string, string> = {};
let cardId = '';
let stmtId = '';
let now = new Date('2026-11-05T10:00:00+08:00');

type Sent = { kind: 'reply' | 'push'; to?: string; messages: any[] };
const sent: Sent[] = [];
const lastReply = () => [...sent].reverse().find((s) => s.kind === 'reply')!;
const replyText = () => lastReply().messages.map((m: any) => m.text ?? m.altText ?? '').join('\n');

// ---- Gemini 對照表：遮罩後的句子 → 應該回的意圖＋欄位原文 ----
const blank = { intent: 'EXPENSE', segment: '', amount: 0, categoryName: '', note: '', dateText: '', accountText: '', ownerText: '', currencyText: '', transferKind: '', fromText: '', toText: '', counterpartyText: '', principal: 0, interest: 0, fee: 0 };
const G: Record<string, any[]> = {
  '午餐 120': [{ ...blank, segment: '午餐 120', amount: 120, categoryName: '餐飲', note: '午餐' }],
  '公司 Zoom 15.99 美金': [{ ...blank, segment: '公司 Zoom 15.99 美金', amount: 15.99, categoryName: '軟體訂閱', note: 'Zoom', currencyText: '美金' }],
  '幫 Apple 記 美髮 1500': [{ ...blank, segment: '幫 Apple 記 美髮 1500', amount: 1500, categoryName: '美容', note: '美髮', ownerText: 'Apple' }],
  '10/3 加油 1200': [{ ...blank, segment: '10/3 加油 1200', amount: 1200, categoryName: '其他支出', note: '加油', dateText: '10/3' }],
  'Apple 轉 1 萬給我': [{ ...blank, intent: 'TRANSFER', segment: 'Apple 轉 1 萬給我', amount: 10000, transferKind: 'SPOUSE', fromText: 'Apple', toText: '我' }],
  'Apple 轉 2000 給我': [{ ...blank, intent: 'TRANSFER', segment: 'Apple 轉 2000 給我', amount: 2000, transferKind: 'SPOUSE', fromText: 'Apple', toText: '我' }],
  'Apple 轉 3000 給我': [{ ...blank, intent: 'TRANSFER', segment: 'Apple 轉 3000 給我', amount: 3000, transferKind: 'SPOUSE', fromText: 'Apple', toText: '我' }],
  '從臺銀繳國泰卡 24261': [{ ...blank, intent: 'TRANSFER', segment: '從臺銀繳國泰卡 24261', amount: 24261, transferKind: 'CARD_PAYMENT', fromText: '臺銀', toText: '國泰卡' }],
  '從臺銀繳台新卡 3000': [{ ...blank, intent: 'TRANSFER', segment: '從臺銀繳台新卡 3000', amount: 3000, transferKind: 'CARD_PAYMENT', fromText: '臺銀', toText: '台新卡' }],
  '臺銀轉 1000 到國泰': [{ ...blank, intent: 'TRANSFER', segment: '臺銀轉 1000 到國泰', amount: 1000, transferKind: 'ACCOUNT', fromText: '臺銀', toText: '國泰' }],
  '午餐 120 刷卡號 [卡號末4:9999]': [{ ...blank, segment: '午餐 120', amount: 1200, categoryName: '餐飲', note: '午餐' }],
};
const seenByGemini: string[] = [];

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

// 每次說話／按按鈕都讓時間往前 1 秒（建立時間才分得出先後）
const tick = () => (now = new Date(now.getTime() + 1000));
const say = (who: 'shark' | 'apple', text: string) =>
  tick() &&
  handleTextMessage({ type: 'message', replyToken: `rt-${Math.random()}`, source: { type: 'user', userId: who === 'shark' ? U_SHARK : U_APPLE }, message: { type: 'text', id: 'x', text } });
const press = (who: 'shark' | 'apple', data: string) =>
  tick() &&
  handlePostback({ type: 'postback', replyToken: `rt-${Math.random()}`, source: { type: 'user', userId: who === 'shark' ? U_SHARK : U_APPLE }, postback: { data } });

async function balances(who: 'shark' | 'apple' = 'shark'): Promise<Record<string, number>> {
  const r = await call(who, 'GET', '/accounts');
  return Object.fromEntries(r.json.accounts.map((a: any) => [a.id, a.balance]));
}
const lastTransfer = () => prisma.transfer.findFirst({ where: { familyId: FAM }, orderBy: { createdAt: 'desc' } });

before(async () => {
  if (SKIP) return;
  process.env.DATABASE_URL = DB_URL;
  process.env.LINE_LOGIN_CHANNEL_ID = CHANNEL;
  process.env.LINE_CHANNEL_SECRET ??= 'test-secret';
  process.env.LINE_CHANNEL_ACCESS_TOKEN ??= 'test-token';
  process.env.LINE_LIFF_ID ??= `${CHANNEL}-test`;
  process.env.GEMINI_API_KEY ??= 'test-gemini';
  process.env.FX_REFERENCE_RATES = JSON.stringify({ USD: 32.5 });

  ({ prisma } = await import('../src/prisma'));
  const { lineClient } = await import('../src/line/client');
  (lineClient as any).replyMessage = async (req: any) => {
    sent.push({ kind: 'reply', messages: req.messages });
    return {};
  };
  (lineClient as any).pushMessage = async (req: any) => {
    sent.push({ kind: 'push', to: req.to, messages: req.messages });
    return {};
  };
  (lineClient as any).getProfile = async () => ({ displayName: 'x' });
  ({ handleTextMessage } = await import('../src/line/handlers/message-text'));
  ({ handlePostback } = await import('../src/line/handlers/postback'));
  ({ notifyExpiredTransfers } = await import('../src/jobs/transfer-confirm'));
  ({ __setLedgerTestHooks: setHooks } = await import('../src/line/handlers/text-ledger'));
  setHooks({
    clock: () => now,
    parser: async (masked: string) => {
      seenByGemini.push(masked);
      const items = G[masked];
      return items ? { isLedger: true, sharedAccountText: '', sharedDateText: '', items } : { isLedger: false, sharedAccountText: '', sharedDateText: '', items: [] };
    },
  });

  const { buildLiffRouter } = await import('../src/routes/liff');
  const { createLiffAuth } = await import('../src/lib/liff-auth');
  const subs: Record<string, string> = { 'tok-shark': U_SHARK, 'tok-apple': U_APPLE };
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

  await prisma.family.create({ data: { id: FAM, name: '文字記帳測試家', familyCode: RUN.slice(0, 6).toUpperCase(), ownerLineId: U_SHARK } });
  await prisma.familyMember.createMany({
    data: [
      { id: SHARK, familyId: FAM, lineUserId: U_SHARK, displayName: 'Shark', role: 'OWNER', joinedAt: new Date('2026-01-01T00:00:00Z') },
      { id: APPLE, familyId: FAM, lineUserId: U_APPLE, displayName: 'Apple', role: 'MEMBER', joinedAt: new Date('2026-01-02T00:00:00Z') },
    ],
  });
  let so = 0;
  for (const [name, type] of [
    ['餐飲', 'EXPENSE'],
    ['軟體訂閱', 'EXPENSE'],
    ['美容', 'EXPENSE'],
    ['其他支出', 'EXPENSE'],
    ['其他收入', 'INCOME'],
  ] as const)
    await prisma.category.create({ data: { familyId: FAM, name, type, sortOrder: so++ } });
  const old = new Date('2026-09-01T00:00:00+08:00');
  const accs: [string, string, any, number, string | null, string, boolean][] = [
    ['cash', '現金', 'CASH', 5000, null, 'FAMILY_FULL', true],
    ['cathay', '國泰活存', 'BANK', 100000, null, 'FAMILY_FULL', false],
    ['wallet', '電子錢包', 'EPAYMENT', 0, null, 'FAMILY_FULL', false],
    ['bot', 'Shark 臺銀', 'BANK', 50000, SHARK, 'FAMILY_TOTAL_ONLY', false],
    ['apple', 'Apple 玉山', 'BANK', 30000, APPLE, 'FAMILY_TOTAL_ONLY', false],
    ['appleSecret', 'Apple 私房', 'BANK', 7000, APPLE, 'OWNER_ONLY', false],
  ];
  let i = 0;
  for (const [k, name, type, opening, owner, vis, isDefault] of accs) {
    const a = await prisma.account.create({
      data: { familyId: FAM, name, type, openingBalance: opening, isDefault, sortOrder: i++, createdAt: old, ...(owner ? { ownerMemberId: owner, visibility: vis } : {}) },
    });
    A[k] = a.id;
  }
  const card = await prisma.creditCard.create({ data: { familyId: FAM, name: '國泰卡', creditLimit: 100000, statementDay: 5, dueDay: 20, cardLast4: '1234', createdAt: old } });
  cardId = card.id;
  const st = await prisma.cardStatement.create({
    data: { familyId: FAM, cardId, statementDate: new Date('2026-10-05T12:00:00+08:00'), dueDate: new Date('2099-10-20T12:00:00+08:00'), newBalance: 24261 },
  });
  stmtId = st.id;
});

after(async () => {
  if (SKIP) return;
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.netWorthSnapshot.deleteMany({ where: { familyId: FAM } });
  await prisma.liabilityPayment.deleteMany({ where: { liability: { familyId: FAM } } });
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

// ================= P1-6 文字記帳補強 =================

test('「午餐 120」舊行為不變：一筆、預設帳戶（現金）、家庭、附快速修正', { skip: SKIP }, async () => {
  await say('shark', '午餐 120');
  const tx = await prisma.transaction.findFirst({ where: { familyId: FAM }, orderBy: { createdAt: 'desc' } });
  assert.equal(Number(tx.amount), 120);
  assert.equal(tx.accountId, A.cash);
  assert.equal(tx.bookTo, 'FAMILY');
  assert.equal(tx.memberId, SHARK);
  assert.ok(replyText().includes('已記帳'));
  assert.ok(lastReply().messages[0].quickReply, '單筆附改分類／改個人／刪除');
});

test('送 Gemini 前遮罩：卡號全碼不會出現在 Gemini 收到的文字；Gemini 金額對不上原句 → 問、不寫入', { skip: SKIP }, async () => {
  const before = await prisma.transaction.count({ where: { familyId: FAM } });
  await say('shark', '午餐 120 刷卡號 4111111111119999');
  assert.ok(seenByGemini.includes('午餐 120 刷卡號 [卡號末4:9999]'));
  assert.ok(!seenByGemini.some((s) => s.includes('4111111111119999')));
  assert.equal(await prisma.transaction.count({ where: { familyId: FAM } }), before, 'Gemini 回 1200、原句是 120 → 不記');
  assert.ok(replyText().includes('金額我抓不準'));
});

test('「10/3 加油 1200」→ 記在 10/3（台北中午）', { skip: SKIP }, async () => {
  await say('shark', '10/3 加油 1200');
  const tx = await prisma.transaction.findFirst({ where: { familyId: FAM }, orderBy: { createdAt: 'desc' } });
  assert.equal(tx.paidAt.toISOString(), '2026-10-03T04:00:00.000Z');
  assert.ok(replyText().includes('2026-10-03'));
});

test('「公司 Zoom 15.99 美金」→ 代墊公司費用、USD 原幣、預估台幣 520；家庭支出不算', { skip: SKIP }, async () => {
  const sum0 = await call('shark', 'GET', '/summary?month=2026-11');
  await say('shark', '公司 Zoom 15.99 美金');
  const tx = await prisma.transaction.findFirst({ where: { familyId: FAM }, orderBy: { createdAt: 'desc' } });
  assert.equal(tx.bookTo, 'BUSINESS');
  assert.equal(tx.reimburseStatus, 'PENDING');
  assert.equal(tx.originalCurrency, 'USD');
  assert.equal(Number(tx.originalAmount), 15.99);
  assert.equal(Number(tx.amount), 520);
  assert.equal(tx.amountEstimated, true);
  // 臺銀牌告查不到（測試庫沒有 2026 的 FxRateDaily）→ 退回 env FX_REFERENCE_RATES，交易記下來源
  assert.equal(tx.fxRateSource, 'ENV');
  assert.equal(Number(tx.fxRate), 32.5);
  assert.equal(tx.fxRateDate, null);
  const sum1 = await call('shark', 'GET', '/summary?month=2026-11');
  assert.equal(sum1.json.totalExpense, sum0.json.totalExpense, '公司費用不進家庭支出');
  assert.ok(replyText().includes('公司（代墊報帳）'));
  assert.ok(replyText().includes('USD 15.99'));
  assert.ok(replyText().includes('依參考匯率 32.5 預估'), replyText());
  const list = await call('shark', 'GET', '/transactions?month=2026-11');
  const row = list.json.items.find((x: any) => x.id === tx.id);
  assert.equal(row.bookTo, 'BUSINESS');
  assert.equal(row.amountEstimated, true);
});

test('「幫 Apple 記 美髮 1500」→ 歸屬 Apple、記錄者 Shark；成員占比算 Apple', { skip: SKIP }, async () => {
  await say('shark', '幫 Apple 記 美髮 1500');
  const tx = await prisma.transaction.findFirst({ where: { familyId: FAM }, orderBy: { createdAt: 'desc' } });
  assert.equal(tx.memberId, APPLE);
  assert.equal(tx.recordedByMemberId, SHARK);
  const sum = await call('shark', 'GET', '/summary?month=2026-11');
  assert.ok(sum.json.byMember.some((m: any) => m.memberId === APPLE && m.amount >= 1500));
  const list = await call('shark', 'GET', '/transactions?month=2026-11');
  assert.equal(list.json.items.find((x: any) => x.id === tx.id).recordedByName, 'Shark');
});

// ================= P1-5 一句話建轉帳 =================

test('「從臺銀繳國泰卡 24261」→ 繳卡費、沖 10 月帳單（已結清）、確認卡有撤銷／改帳戶／改金額', { skip: SKIP }, async () => {
  const b0 = await balances();
  await say('shark', '從臺銀繳國泰卡 24261');
  const tr = await lastTransfer();
  assert.equal(tr.kind, 'CARD_PAYMENT');
  assert.equal(tr.source, 'TEXT');
  assert.equal(tr.fromAccountId, A.bot);
  assert.equal(tr.confirmStatus, 'CONFIRMED');
  const st = await prisma.cardStatement.findUnique({ where: { id: stmtId } });
  assert.equal(st.status, 'PAID');
  const b1 = await balances();
  assert.equal(b1[A.bot] - b0[A.bot], -24261);
  const flex = lastReply().messages.find((m: any) => m.type === 'flex');
  const json = JSON.stringify(flex);
  assert.ok(json.includes('已沖 10 月帳單'), json);
  for (const a of ['tr_undo', 'tr_acct', 'tr_amt']) assert.ok(json.includes(`action=${a}&id=${tr.id}`), a);
  // 撤銷：只有建立者
  await press('apple', `action=tr_undo&id=${tr.id}`);
  assert.ok(replyText().includes('只有記這筆的人'), replyText());
  await press('shark', `action=tr_undo&id=${tr.id}`);
  assert.ok(replyText().includes('已撤銷'));
  assert.equal((await prisma.cardStatement.findUnique({ where: { id: stmtId } })).status, 'OPEN');
  assert.deepEqual(await balances(), b0);
});

test('撤銷窗口：LINE 一鍵撤銷只在 24 小時內；超過要到 LIFF（LIFF 仍可撤）', { skip: SKIP }, async () => {
  await say('shark', '從臺銀繳國泰卡 24261');
  const tr = await lastTransfer();
  const saved = now;
  now = new Date(saved.getTime() + 25 * 3600 * 1000);
  await press('shark', `action=tr_undo&id=${tr.id}`);
  assert.ok(replyText().includes('超過 24 小時'), replyText());
  now = saved;
  const r = await call('shark', 'POST', `/transfers/${tr.id}/undo`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('改金額：按「改金額」→ 打新金額 → 舊的撤銷、新建一筆', { skip: SKIP }, async () => {
  await say('shark', '從臺銀繳國泰卡 24261');
  const tr = await lastTransfer();
  await press('shark', `action=tr_amt&id=${tr.id}`);
  assert.ok(replyText().includes('新的金額'));
  await say('shark', '20000');
  const old = await prisma.transfer.findUnique({ where: { id: tr.id } });
  assert.ok(old.undoneAt, '舊的撤銷');
  const nw = await lastTransfer();
  assert.notEqual(nw.id, tr.id);
  assert.equal(Number(nw.amount), 20000);
  assert.equal((await prisma.cardStatement.findUnique({ where: { id: stmtId } })).status, 'PARTIAL');
  await call('shark', 'POST', `/transfers/${nw.id}/undo`);
});

test('多個候選一定問（國泰＝活存／卡）；點過的叫法記成別名，下次不再問', { skip: SKIP }, async () => {
  await say('shark', '臺銀轉 1000 到國泰');
  const q = lastReply().messages[0];
  assert.ok(q.quickReply, '要問');
  const datas = q.quickReply.items.map((i: any) => i.action.data);
  assert.ok(datas.includes(`action=lp_pick&c=ACCOUNT:${A.cathay}`));
  assert.ok(datas.includes(`action=lp_pick&c=CARD:${cardId}`));
  assert.ok(datas.includes('action=lp_none'));
  assert.ok(q.quickReply.items.length <= 5, '候選最多 4 個＋都不是');
  const n0 = await prisma.transfer.count({ where: { familyId: FAM } });
  await press('shark', `action=lp_pick&c=ACCOUNT:${A.cathay}`);
  const tr = await lastTransfer();
  assert.equal(await prisma.transfer.count({ where: { familyId: FAM } }), n0 + 1);
  assert.equal(tr.toAccountId, A.cathay);
  assert.equal(tr.kind, 'ACCOUNT');
  const acc = await prisma.account.findUnique({ where: { id: A.cathay } });
  assert.ok(acc.aliases.includes('國泰'), JSON.stringify(acc.aliases));
  await say('shark', '臺銀轉 1000 到國泰');
  const tr2 = await lastTransfer();
  assert.notEqual(tr2.id, tr.id, '這次直接建立，不再問');
  assert.equal(tr2.toAccountId, A.cathay);
  await call('shark', 'POST', `/transfers/${tr.id}/undo`);
  await call('shark', 'POST', `/transfers/${tr2.id}/undo`);
});

// ================= D18：動到對方個人帳戶 → 待對方確認 =================

test('D18：「Apple 轉 1 萬給我」→ 待 Apple 確認；推確認卡給 Apple；確認前兩邊都不動、Shark 不能代按', { skip: SKIP }, async () => {
  const b0 = await balances();
  const pushes0 = sent.filter((s) => s.kind === 'push').length;
  await say('shark', 'Apple 轉 1 萬給我');
  const tr = await lastTransfer();
  assert.equal(tr.kind, 'SPOUSE');
  assert.equal(tr.confirmStatus, 'PENDING');
  assert.equal(tr.counterpartMemberId, APPLE);
  assert.equal(tr.counterpartSide, 'FROM');
  assert.equal(tr.fromAccountId, A.apple);
  assert.equal(tr.toAccountId, A.bot);
  assert.equal(tr.confirmDeadline.getTime() - tr.createdAt.getTime(), 24 * 3600 * 1000);
  assert.deepEqual(await balances(), b0, '待確認：餘額不動');
  const flexJson = JSON.stringify(lastReply().messages);
  assert.ok(flexJson.includes('待 Apple 確認'));
  assert.ok(!flexJson.includes('action=tr_acct'), '待確認的卡只有撤銷');
  const push = sent.filter((s) => s.kind === 'push').slice(pushes0).find((s) => s.to === U_APPLE);
  assert.ok(push, '推確認卡給 Apple');
  const pj = JSON.stringify(push!.messages);
  assert.ok(pj.includes(`action=tr_ok&id=${tr.id}`) && pj.includes(`action=tr_no&id=${tr.id}`));
  // Shark 不能替 Apple 確認
  await press('shark', `action=tr_ok&id=${tr.id}`);
  assert.ok(replyText().includes('被動到帳戶的那位確認'), replyText());
  const r = await call('shark', 'POST', `/transfers/${tr.id}/confirm`);
  assert.equal(r.status, 403);
  // Apple 在 LIFF 也看得到、可以確認
  const list = await call('apple', 'GET', '/transfers?month=2026-11');
  const row = list.json.items.find((x: any) => x.id === tr.id);
  assert.equal(row.canConfirm, true);
  assert.equal(row.confirmStatus, 'PENDING');
  // Apple 按確認 → 兩邊才動；家庭淨資產（Shark 看）不變
  const nw0 = (await call('shark', 'GET', '/overview')).json.netWorth.netWorth;
  await press('apple', `action=tr_ok&id=${tr.id}`);
  assert.ok(replyText().includes('已確認'));
  const after = await prisma.transfer.findUnique({ where: { id: tr.id } });
  assert.equal(after.confirmStatus, 'CONFIRMED');
  const b1 = await balances();
  assert.equal(b1[A.apple] - b0[A.apple], -10000);
  assert.equal(b1[A.bot] - b0[A.bot], 10000);
  const nw1 = (await call('shark', 'GET', '/overview')).json.netWorth.netWorth;
  assert.equal(nw1, nw0, '夫妻互轉家庭淨資產不變');
  assert.ok(sent.some((s) => s.kind === 'push' && s.to === U_SHARK && JSON.stringify(s.messages).includes('確認了')), '通知建立者');
  // 撤銷（建立者）→ 還原
  await press('shark', `action=tr_undo&id=${tr.id}`);
  assert.deepEqual(await balances(), b0);
});

test('D18：Apple 拒絕 → 不生效（紀錄留著）', { skip: SKIP }, async () => {
  const b0 = await balances();
  await say('shark', 'Apple 轉 2000 給我');
  const tr = await lastTransfer();
  await press('apple', `action=tr_no&id=${tr.id}`);
  assert.ok(replyText().includes('已拒絕'));
  const t = await prisma.transfer.findUnique({ where: { id: tr.id } });
  assert.equal(t.confirmStatus, 'REJECTED');
  assert.deepEqual(await balances(), b0);
  await press('apple', `action=tr_ok&id=${tr.id}`);
  assert.ok(replyText().includes('拒絕'), '拒絕後不能再確認');
});

test('D18：24 小時沒確認 → 只記 Shark 這邊（待確認），Apple 之後仍可確認 → 兩邊都生效', { skip: SKIP }, async () => {
  const b0 = await balances();
  await say('shark', 'Apple 轉 3000 給我');
  const tr = await lastTransfer();
  assert.equal((await notifyExpiredTransfers(new Date(now.getTime() + 23 * 3600 * 1000))).expired, 0, '還沒到 24 小時');
  const r = await notifyExpiredTransfers(new Date(now.getTime() + 24 * 3600 * 1000 + 1000));
  assert.equal(r.expired, 1);
  const t = await prisma.transfer.findUnique({ where: { id: tr.id } });
  assert.equal(t.confirmStatus, 'ONE_SIDED');
  assert.ok(sent.some((s) => s.kind === 'push' && s.to === U_SHARK && JSON.stringify(s.messages).includes('只記在你這邊')));
  const b1 = await balances();
  assert.equal(b1[A.bot] - b0[A.bot], 3000, 'Shark 收入側先記（待確認）');
  assert.equal(b1[A.apple], b0[A.apple], 'Apple 的帳戶不動');
  const confirmed = await call('apple', 'POST', `/transfers/${tr.id}/confirm`);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  assert.equal(confirmed.json.confirmStatus, 'CONFIRMED');
  const b2 = await balances();
  assert.equal(b2[A.apple] - b0[A.apple], -3000);
  assert.equal(b2[A.bot] - b0[A.bot], 3000);
  await call('shark', 'POST', `/transfers/${tr.id}/undo`);
  assert.deepEqual(await balances(), b0);
});

test('D18 不影響 LIFF 手動轉帳舊規則：別人的帳戶不能當來源（403）', { skip: SKIP }, async () => {
  const r = await call('shark', 'POST', '/transfers', { kind: 'SPOUSE', fromAccountId: A.apple, toAccountId: A.bot, amount: 100 });
  assert.equal(r.status, 403);
});

// ================= P1-7 淨資產快照與全貌 =================

test('全貌：淨資產＝帳戶＋借出－借入－信用卡已出帳未繳＋代墊公司費用（依可見範圍：Apple 私房只算進 Apple 的）', { skip: SKIP }, async () => {
  const lend = await call('shark', 'POST', '/transfers', { kind: 'LEND', fromAccountId: A.cathay, newLiability: { name: '小明' }, amount: 5000 });
  assert.equal(lend.status, 200, JSON.stringify(lend.json));
  const loan = await call('shark', 'POST', '/liabilities', { name: '房貸', kind: 'MORTGAGE', direction: 'BORROWED', principal: 1000000, annualRate: 2, termMonths: 240, startDate: '2026-01-10', method: 'EQUAL_PAYMENT' });
  assert.equal(loan.status, 200);
  const [shark, apple] = await Promise.all([call('shark', 'GET', '/overview?month=2026-11'), call('apple', 'GET', '/overview?month=2026-11')]);
  assert.equal(shark.status, 200, JSON.stringify(shark.json));
  const accS = await call('shark', 'GET', '/accounts');
  const accTotal = accS.json.accounts.reduce((s: number, a: any) => s + a.balance, 0);
  const lia = await call('shark', 'GET', '/liabilities');
  const stmt = await prisma.cardStatement.findUnique({ where: { id: stmtId } });
  const cardUnpaid = Number(stmt.newBalance) - Number(stmt.paidAmount);
  const receivable = 520; // 公司 Zoom
  const expected = Math.round((accTotal + lia.json.totals.lent - lia.json.totals.borrowed - cardUnpaid + receivable) * 100) / 100;
  assert.equal(shark.json.netWorth.netWorth, expected, JSON.stringify(shark.json.netWorth.composition));
  assert.equal(shark.json.receivable, 520);
  assert.ok(apple.json.netWorth.netWorth - shark.json.netWorth.netWorth === 7000, 'Apple 看得到自己的私房 7000，Shark 看不到');
  // 組成：Shark 看 Apple 的個人帳戶只看得到總額 → 併成一塊，不露名稱
  assert.ok(shark.json.netWorth.composition.assets.some((a: any) => a.key === 'othersTotal'));
  assert.ok(!JSON.stringify(shark.json.netWorth.rows).includes('Apple 玉山'));
  assert.ok(!JSON.stringify(shark.json).includes('Apple 私房'));
  // 每人一條線
  const owners = shark.json.netWorth.byOwner.map((o: any) => o.name);
  assert.deepEqual(owners.slice(0, 2), ['共同', 'Shark']);
  // 現金流：排除轉帳與公司費用
  const sum = await call('shark', 'GET', '/summary?month=2026-11');
  assert.equal(shark.json.cashflow.expense, sum.json.totalExpense);
  assert.equal(shark.json.cashflow.saved, Math.round((sum.json.totalIncome - sum.json.totalExpense) * 100) / 100);
  // 負債還清時間表
  const mortgage = shark.json.payoff.find((p: any) => p.name === '房貸');
  assert.equal(mortgage.payoffDate, '2045-12-10');
  assert.ok(mortgage.monthsLeft > 200);
  assert.equal(shark.json.history.at(-1).live, true);
});

test('快照：手動重算 10 月 → 每人一份；之後改 10 月舊資料，歷史點不跳；再按重算才更新', { skip: SKIP }, async () => {
  const r = await call('shark', 'POST', '/net-worth/snapshots', { month: '2026-10' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.written, 2);
  const bad = await call('shark', 'POST', '/net-worth/snapshots', { month: '2026-11' });
  assert.equal(bad.status, 400, '本月不能存快照');
  const ov1 = await call('shark', 'GET', '/overview');
  const oct1 = ov1.json.history.find((h: any) => h.month === '2026-10');
  assert.ok(oct1, JSON.stringify(ov1.json.history));
  // 10/3 加油 1200 已經在（P1-6 測試記的），10 月的帳戶餘額＝期初－1200；之後的轉帳、11 月的收支都不算
  const snap = await prisma.netWorthSnapshot.findUnique({ where: { familyId_month_viewerMemberId: { familyId: FAM, month: '2026-10', viewerMemberId: SHARK } } });
  assert.equal(Number(snap.netWorth), oct1.netWorth);
  // 改舊資料：補一筆 10/15 支出 1000
  const cat = await prisma.category.findFirst({ where: { familyId: FAM, name: '餐飲' } });
  await prisma.transaction.create({ data: { familyId: FAM, memberId: SHARK, categoryId: cat.id, accountId: A.cash, amount: 1000, paidAt: new Date('2026-10-15T12:00:00+08:00') } });
  const ov2 = await call('shark', 'GET', '/overview');
  assert.equal(ov2.json.history.find((h: any) => h.month === '2026-10').netWorth, oct1.netWorth, '歷史點不跳');
  // 自動排程（不覆寫）也不會改
  const { runMonthlySnapshots } = await import('../src/services/net-worth');
  await runMonthlySnapshots(new Date('2026-11-01T08:30:00+08:00'));
  const ov3 = await call('shark', 'GET', '/overview');
  assert.equal(ov3.json.history.find((h: any) => h.month === '2026-10').netWorth, oct1.netWorth);
  // 手動重算 → 少 1000
  await call('shark', 'POST', '/net-worth/snapshots', { month: '2026-10' });
  const ov4 = await call('shark', 'GET', '/overview');
  assert.equal(ov4.json.history.find((h: any) => h.month === '2026-10').netWorth, Math.round((oct1.netWorth - 1000) * 100) / 100);
});

test('快照時間點：10 月底之後才借出的 5000、才建的房貸不算進 10 月', { skip: SKIP }, async () => {
  const snap = await prisma.netWorthSnapshot.findUnique({ where: { familyId_month_viewerMemberId: { familyId: FAM, month: '2026-10', viewerMemberId: SHARK } } });
  const b = snap.breakdown as any;
  assert.ok(!b.composition.assets.some((a: any) => a.key === 'lent'), JSON.stringify(b.composition));
  assert.ok(!b.composition.liabilities.some((a: any) => a.key === 'mortgage'));
  // 10 月的卡帳單（10/5 結帳、應繳 24261、10 月底前沒繳）算負債
  assert.ok(b.composition.liabilities.some((a: any) => a.key === 'card' && a.amount === 24261));
});

// MED-1：文字記帳繳卡費找不到可沖的帳單 → 聊天裡問「確定預繳」；按確定才記（同溢繳的確認流程）
test('「從臺銀繳台新卡 3000」（台新卡還沒有帳單）→ 問確定預繳；取消不記；確定才記成預繳，帳單建立時抵扣', { skip: SKIP }, async () => {
  const card = await prisma.creditCard.create({ data: { familyId: FAM, name: '台新卡', creditLimit: 50000, statementDay: 10, dueDay: 25 } });
  const b0 = await balances();
  const count0 = await prisma.transfer.count({ where: { familyId: FAM, toCreditCardId: card.id } });

  await say('shark', '從臺銀繳台新卡 3000');
  assert.ok(replyText().includes('還沒有登錄帳單') && replyText().includes('預繳'), replyText());
  const qr = JSON.stringify(lastReply().messages.at(-1).quickReply);
  assert.ok(qr.includes('確定預繳') && qr.includes('action=lp_overpay'), qr);
  assert.equal(await prisma.transfer.count({ where: { familyId: FAM, toCreditCardId: card.id } }), count0, '還沒確認不記');
  await press('shark', 'action=lp_cancel');
  assert.deepEqual(await balances(), b0);

  await say('shark', '從臺銀繳台新卡 3000');
  await press('shark', 'action=lp_overpay');
  // 不用 lastTransfer()：前面 LIFF 建的轉帳用真實時間，createdAt 比測試時鐘晚
  const tr = await prisma.transfer.findFirst({ where: { familyId: FAM, toCreditCardId: card.id } });
  assert.deepEqual([tr.kind, tr.toCreditCardId, tr.cardStatementId, tr.source], ['CARD_PAYMENT', card.id, null, 'TEXT']);
  const b1 = await balances();
  assert.equal(b1[A.bot] - b0[A.bot], -3000);
  assert.equal((await call('shark', 'GET', `/credit-cards/${card.id}/statements`)).json.prepaid, 3000);

  const st = await call('shark', 'POST', `/credit-cards/${card.id}/statements`, { statementDate: '2026-11-01', dueDate: '2099-11-25', newBalance: 4000 });
  assert.deepEqual([st.json.paidAmount, st.json.status, st.json.remaining], [3000, 'PARTIAL', 1000]);
  await call('shark', 'POST', `/transfers/${tr.id}/undo`);
  await prisma.cardStatement.deleteMany({ where: { cardId: card.id } });
  await prisma.transfer.deleteMany({ where: { toCreditCardId: card.id } });
  await prisma.creditCard.delete({ where: { id: card.id } });
});
