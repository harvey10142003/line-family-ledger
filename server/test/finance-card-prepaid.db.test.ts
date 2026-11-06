// MED-1（11-06 QA）：繳卡費找不到可沖的帳單時，錢不能從淨資產消失。
// 走真的 /api/liff/* 路由＋真的 PostgreSQL（同 finance-transfer-liability.db.test.ts）。
//   LEDGER_TEST_DATABASE_URL=postgresql://user@127.0.0.1:5432/ledger_test npm --workspace server test
// 沒設就整支跳過。只接受 127.0.0.1／localhost。
//
// 規則：
// - 卡還沒有帳單、或最近一期已繳清又再繳 → 409 no_statement_needs_confirm，什麼都不動
// - 帶 confirmOverpay 確認 → 記成這張卡的預繳（cardStatementId 留空）：來源帳戶扣錢、淨資產不變（預繳算資產＝負的未繳）
// - 之後建立新帳單 → 只有「付款日（台北日期）晚於結帳日」的預繳整筆沖進去（規則 A，Shark 11-06）
// - 結帳日當天或以前付的預繳 → 銀行帳單的本期應繳已經扣掉了：不沖、不加已繳、cardStatementId 留空，
//   也不再算淨資產的預繳（不重複扣）
// - 撤銷已沖進帳單的預繳 → 帳單已繳還原、帳戶還原
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
const FAM = `famP_${RUN}`;
const SHARK = `msP_${RUN}`;
const DAY = '2026-10-20';

let prisma: any;
let base = '';
let server: any;
let bankId = '';

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api/liff${path}`, {
    method,
    headers: { authorization: 'Bearer tok-shark', ...(body ? { 'content-type': 'application/json' } : {}) },
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

const r2 = (x: number) => Math.round(x * 100) / 100;
const netWorth = async () => {
  const r = await call('GET', '/overview?month=2026-10');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.netWorth.netWorth as number;
};
const bank = async () => (await call('GET', '/accounts')).json.accounts.find((a: any) => a.id === bankId).balance as number;
const statements = async (cardId: string) => (await call('GET', `/credit-cards/${cardId}/statements`)).json;
const newCard = async (name: string) => (await prisma.creditCard.create({ data: { familyId: FAM, name, creditLimit: 100000, statementDay: 5, dueDay: 20 } })).id as string;
const pay = (cardId: string, amount: number, extra: Record<string, unknown> = {}) =>
  call('POST', '/transfers', { kind: 'CARD_PAYMENT', fromAccountId: bankId, toCreditCardId: cardId, amount, transferredAt: DAY, ...extra });

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
  const sub = `UP_shark_${RUN}`;
  const fakeFetch = (async (_url: any, init?: any) => {
    const ok = new URLSearchParams(String(init?.body ?? '')).get('id_token') === 'tok-shark';
    const json = ok ? { sub, aud: CHANNEL, exp: Math.floor(Date.now() / 1000) + 3600 } : { error: 'invalid_request' };
    return new Response(JSON.stringify(json), { status: ok ? 200 : 400, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/liff', buildLiffRouter(createLiffAuth({ channelId: CHANNEL, fetchImpl: fakeFetch })));
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await prisma.family.create({ data: { id: FAM, name: '預繳測試家', familyCode: RUN.slice(0, 6).toUpperCase(), ownerLineId: sub } });
  await prisma.familyMember.create({ data: { id: SHARK, familyId: FAM, lineUserId: sub, displayName: 'Shark', role: 'OWNER' } });
  const a = await prisma.account.create({ data: { familyId: FAM, name: '共同銀行', type: 'BANK', openingBalance: 100000, isDefault: true, createdAt: new Date('2026-01-01T00:00:00Z') } });
  bankId = a.id;
});

after(async () => {
  if (SKIP) return;
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.netWorthSnapshot.deleteMany({ where: { familyId: FAM } });
  await prisma.transfer.deleteMany({ where: { familyId: FAM } });
  await prisma.transaction.deleteMany({ where: { familyId: FAM } });
  await prisma.cardStatement.deleteMany({ where: { familyId: FAM } });
  await prisma.account.deleteMany({ where: { familyId: FAM } });
  await prisma.creditCard.deleteMany({ where: { familyId: FAM } });
  await prisma.category.deleteMany({ where: { familyId: FAM } });
  await prisma.familyMember.deleteMany({ where: { familyId: FAM } });
  await prisma.family.delete({ where: { id: FAM } });
  await prisma.$disconnect();
});

test('卡還沒有帳單：沒確認 → 409 不動；確認 → 預繳，淨資產不變；建新帳單 → 自動抵扣；撤銷 → 帳單已繳還原', { skip: SKIP }, async () => {
  const card = await newCard('沒帳單卡');
  const nw0 = await netWorth();
  const b0 = await bank();

  // 沒確認：409，什麼都沒動（這就是修之前「錢消失」的那條路）
  const r = await pay(card, 5000);
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.code, 'no_statement_needs_confirm');
  assert.equal(r.json.detail.reason, 'no_statement');
  assert.equal(r.json.detail.amount, 5000);
  assert.equal(await bank(), b0);
  assert.equal(await prisma.transfer.count({ where: { familyId: FAM, toCreditCardId: card } }), 0);

  // 確認：記成預繳
  const ok = await pay(card, 5000, { confirmOverpay: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.statement, null);
  const tr = await prisma.transfer.findUnique({ where: { id: ok.json.id } });
  assert.equal(tr.cardStatementId, null);
  assert.equal(await bank(), b0 - 5000);
  assert.equal((await statements(card)).prepaid, 5000);
  assert.equal(await netWorth(), nw0, '預繳算資產：帳戶少 5000、卡多 5000 預繳，淨資產不變');

  // 建新帳單 3000（結帳日 10/15，預繳是 10/20 付的＝結帳日之後）：預繳 5000 整筆沖進去 → 已繳 5000、溢繳 2000、PAID
  const st = await call('POST', `/credit-cards/${card}/statements`, { statementDate: '2026-10-15', dueDate: '2099-10-30', newBalance: 3000 });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  assert.deepEqual([st.json.paidAmount, st.json.status, st.json.overpaid, st.json.remaining], [5000, 'PAID', 2000, 0]);
  assert.equal((await prisma.transfer.findUnique({ where: { id: ok.json.id } })).cardStatementId, st.json.id);
  assert.equal((await statements(card)).prepaid, 0, '沖進帳單後就不再是預繳');
  assert.equal(await netWorth(), r2(nw0 - 3000), '多了一期 3000 的應繳（被預繳抵掉），淨資產＝原本 − 3000');

  // 同一期重送（更新金額）不會重複抵扣
  const again = await call('POST', `/credit-cards/${card}/statements`, { statementDate: '2026-10-15', dueDate: '2099-10-30', newBalance: 6000 });
  assert.deepEqual([again.json.id, again.json.paidAmount, again.json.status, again.json.remaining], [st.json.id, 5000, 'PARTIAL', 1000]);
  assert.equal(await netWorth(), r2(nw0 - 6000));

  // 撤銷那筆預繳：帳單已繳還原成 0、帳戶還原
  const u = await call('POST', `/transfers/${ok.json.id}/undo`);
  assert.equal(u.status, 200, JSON.stringify(u.json));
  const after = (await statements(card)).items[0];
  assert.deepEqual([after.paidAmount, after.status], [0, 'OPEN']);
  assert.equal(await bank(), b0);
  assert.equal(await netWorth(), r2(nw0 - 6000), '撤銷後只剩帳單應繳');
});

test('最近一期已繳清又再繳：409 all_paid；確認 → 預繳算資產；下一期結帳日以前付的不抵扣、不重複算淨資產（規則 A）；撤銷只還原帳戶', { skip: SKIP }, async () => {
  const card = await newCard('已繳清卡');
  const st1 = await call('POST', `/credit-cards/${card}/statements`, { statementDate: '2026-10-05', dueDate: '2099-10-20', newBalance: 1000 });
  assert.equal(st1.status, 200);
  const nwBill = await netWorth();
  const p1 = await pay(card, 1000);
  assert.equal(p1.status, 200, JSON.stringify(p1.json));
  assert.equal(p1.json.statement.status, 'PAID');
  const nw0 = await netWorth();
  assert.equal(nw0, nwBill, '繳清本期：帳戶 −1000、應繳 −1000');
  const b0 = await bank();

  const r = await pay(card, 500);
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.code, 'no_statement_needs_confirm');
  assert.equal(r.json.detail.reason, 'all_paid');
  assert.equal(r.json.detail.latestStatementId, st1.json.id);
  assert.equal(await bank(), b0);

  const ok = await pay(card, 500, { confirmOverpay: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.statement, null);
  const stmts = await statements(card);
  assert.equal(stmts.prepaid, 500);
  assert.deepEqual([stmts.items[0].paidAmount, stmts.items[0].status], [1000, 'PAID'], '已繳清那期不動');
  assert.equal(await bank(), b0 - 500);
  assert.equal(await netWorth(), nw0, '預繳 500 算資產：淨資產不變');
  const ov = await call('GET', '/overview?month=2026-10');
  const row = ov.json.netWorth.rows.find((x: any) => x.name === '已繳清卡');
  assert.equal(row.amount, -500, '卡那一列是負的未繳（＝預繳）');

  // 歷史時間點：10 月底（第二期 11/5 還沒出帳）時，那 500 仍是預繳
  const { computeForViewer } = await import('../src/services/net-worth');
  const { loadAccessScope } = await import('../src/services/access');
  const { monthEndTaipei } = await import('../src/lib/net-worth');
  const cardRow = async (month: string) =>
    (await computeForViewer(FAM, await loadAccessScope(FAM, SHARK), monthEndTaipei(month))).rows.find((x: any) => x.name === '已繳清卡')?.amount;
  assert.equal(await cardRow('2026-10'), -500);

  // 規則 A：下一期結帳日 11/5，那 500 是 10/20（結帳日以前）付的 → 銀行的本期應繳 1500 已經扣掉它了
  // → 不抵扣（已繳 0、OPEN、剩 1500）、轉帳 cardStatementId 留空、也不再算預繳
  const st2 = await call('POST', `/credit-cards/${card}/statements`, { statementDate: '2026-11-05', dueDate: '2099-11-20', newBalance: 1500 });
  assert.equal(st2.status, 200, JSON.stringify(st2.json));
  assert.deepEqual([st2.json.paidAmount, st2.json.status, st2.json.remaining], [0, 'OPEN', 1500]);
  assert.equal((await prisma.transfer.findUnique({ where: { id: ok.json.id } })).cardStatementId, null);
  assert.equal((await statements(card)).prepaid, 0, '已被銀行帳單計入，不再是預繳');
  // 淨資產：這期消費 2000（銀行已用 500 抵成應繳 1500）→ 比 nw0 少 2000；舊規則會再扣一次 500 變成只少 1500（重複扣）
  assert.equal(await netWorth(), r2(nw0 - 2000));
  assert.equal((await call('GET', '/overview?month=2026-11')).json.netWorth.rows.find((x: any) => x.name === '已繳清卡').amount, 1500);
  assert.equal(await cardRow('2026-10'), -500, '10 月底的歷史點不受 11/5 那期影響');
  assert.equal(await cardRow('2026-11'), 1500, '11 月底：只剩應繳 1500，不再扣預繳');

  // 同一期重送不會把它沖進來
  const again = await call('POST', `/credit-cards/${card}/statements`, { statementDate: '2026-11-05', dueDate: '2099-11-20', newBalance: 1500 });
  assert.deepEqual([again.json.id, again.json.paidAmount], [st2.json.id, 0]);

  // 撤銷那 500：帳戶還原、帳單不動（沒沖帳單＝沒東西要還原）、預繳仍是 0
  const u = await call('POST', `/transfers/${ok.json.id}/undo`);
  assert.equal(u.status, 200, JSON.stringify(u.json));
  assert.equal(u.json.statement, null);
  assert.equal(await bank(), b0);
  const after = await statements(card);
  assert.deepEqual([after.items[0].paidAmount, after.prepaid], [0, 0]);
  assert.equal(await netWorth(), r2(nw0 - 1500));
});

test('已撤銷的繳卡費不算預繳，也不會被新帳單沖到', { skip: SKIP }, async () => {
  const card = await newCard('撤銷卡');
  const ok = await pay(card, 800, { confirmOverpay: true });
  assert.equal(ok.status, 200);
  assert.equal((await call('POST', `/transfers/${ok.json.id}/undo`)).status, 200);
  assert.equal((await statements(card)).prepaid, 0);
  const st = await call('POST', `/credit-cards/${card}/statements`, { statementDate: '2026-11-05', dueDate: '2099-11-20', newBalance: 800 });
  assert.deepEqual([st.json.paidAmount, st.json.status], [0, 'OPEN']);
  assert.equal((await prisma.transfer.findUnique({ where: { id: ok.json.id } })).cardStatementId, null);
});

// 直接寫轉帳列（可指定到秒），用來測台北日期邊界；帳戶餘額由轉帳本身算，不需另外動帳戶
const rawPay = async (cardId: string, amount: number, at: string) =>
  (await prisma.transfer.create({ data: { familyId: FAM, memberId: SHARK, kind: 'CARD_PAYMENT', fromAccountId: bankId, toCreditCardId: cardId, amount, transferredAt: new Date(at) } })).id as string;

test('結帳日當天的邊界用台北日期：11/5 23:59:59 付的不抵扣，11/6 00:00 付的（UTC 仍是 11/5）會抵扣', { skip: SKIP }, async () => {
  const card = await newCard('邊界卡');
  const sameDayLate = await rawPay(card, 300, '2026-11-05T23:59:59+08:00');
  const sameDayNoon = await rawPay(card, 200, '2026-11-05T12:00:00+08:00');
  const nextDay = await rawPay(card, 700, '2026-11-06T00:00:00+08:00'); // 2026-11-05T16:00Z
  assert.equal((await statements(card)).prepaid, 1200, '還沒帳單：三筆都是預繳');
  const nwBefore = await netWorth();

  const st = await call('POST', `/credit-cards/${card}/statements`, { statementDate: '2026-11-05', dueDate: '2099-11-20', newBalance: 1000 });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  assert.deepEqual([st.json.paidAmount, st.json.status, st.json.remaining], [700, 'PARTIAL', 300]);
  const sid = async (id: string) => (await prisma.transfer.findUnique({ where: { id } })).cardStatementId;
  assert.deepEqual([await sid(sameDayLate), await sid(sameDayNoon), await sid(nextDay)], [null, null, st.json.id]);
  assert.equal((await statements(card)).prepaid, 0);
  // 淨資產：結帳日當天那 500 已在應繳 1000 裡 → 預繳少 1200、卡只欠 1000−700＝300
  assert.equal(await netWorth(), r2(nwBefore - 1200 - 300));
});

test('跨月：8/20、9/20 兩筆預繳，9/5 帳單只抵 9/20 那筆；之後 10/5 帳單不再抵；補登舊的 8/5 帳單也不抵', { skip: SKIP }, async () => {
  const card = await newCard('跨月卡');
  const p1 = await pay(card, 400, { transferredAt: '2026-08-20', confirmOverpay: true });
  const p2 = await pay(card, 900, { transferredAt: '2026-09-20', confirmOverpay: true });
  assert.deepEqual([p1.status, p2.status], [200, 200]);
  assert.equal((await statements(card)).prepaid, 1300);

  const { computeForViewer } = await import('../src/services/net-worth');
  const { loadAccessScope } = await import('../src/services/access');
  const { monthEndTaipei } = await import('../src/lib/net-worth');
  const cardRow = async (month: string) =>
    (await computeForViewer(FAM, await loadAccessScope(FAM, SHARK), monthEndTaipei(month))).rows.find((x: any) => x.name === '跨月卡')?.amount;

  const s9 = await call('POST', `/credit-cards/${card}/statements`, { statementDate: '2026-09-05', dueDate: '2099-09-20', newBalance: 2000 });
  assert.deepEqual([s9.json.paidAmount, s9.json.status, s9.json.remaining], [900, 'PARTIAL', 1100]);
  const sid = async (id: string) => (await prisma.transfer.findUnique({ where: { id } })).cardStatementId;
  assert.deepEqual([await sid(p1.json.id), await sid(p2.json.id)], [null, s9.json.id]);
  assert.equal((await statements(card)).prepaid, 0);
  assert.equal(await cardRow('2026-08'), -400, '8 月底還沒有帳單：8/20 那筆是預繳');
  assert.equal(await cardRow('2026-09'), 1100, '9 月底：8/20 已算進 9/5 帳單，9/20 已沖進去 → 剩 1100');

  // 10/5 帳單：8/20 那筆仍留空也不抵扣（早於 10/5），9/20 那筆已經沖在 9/5 那期
  const s10 = await call('POST', `/credit-cards/${card}/statements`, { statementDate: '2026-10-05', dueDate: '2099-10-20', newBalance: 500 });
  assert.deepEqual([s10.json.paidAmount, s10.json.status], [0, 'OPEN']);
  assert.equal(await cardRow('2026-10'), 500);

  // 補登更舊的 8/5 帳單：不是最新一期 → 什麼都不沖
  const s8 = await call('POST', `/credit-cards/${card}/statements`, { statementDate: '2026-08-05', dueDate: '2099-08-20', newBalance: 300 });
  assert.deepEqual([s8.json.paidAmount, s8.json.status], [0, 'OPEN']);
  assert.deepEqual([await sid(p1.json.id), await sid(p2.json.id)], [null, s9.json.id]);
  assert.equal((await statements(card)).prepaid, 0);

  // 撤銷 9/20 那筆 → 9/5 那期已繳還原成 0；已撤銷的不會回來變預繳
  assert.equal((await call('POST', `/transfers/${p2.json.id}/undo`)).status, 200);
  const after = await statements(card);
  assert.deepEqual(after.items.map((x: any) => [x.statementDate, x.paidAmount]), [['2026-10-05', 0], ['2026-09-05', 0], ['2026-08-05', 0]]);
  assert.equal(after.prepaid, 0);
});

test('最近一期結帳日當天或以前補記的繳卡費：409 說明已算進帳單；確認後記下但不當預繳', { skip: SKIP }, async () => {
  const card = await newCard('補記卡');
  await call('POST', `/credit-cards/${card}/statements`, { statementDate: '2026-10-05', dueDate: '2099-10-20', newBalance: 1000 });
  assert.equal((await pay(card, 1000)).status, 200);
  const r = await pay(card, 200, { transferredAt: '2026-10-05' });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.deepEqual([r.json.code, r.json.detail.countedInStatement, r.json.detail.latestStatementDate], ['no_statement_needs_confirm', true, '2026-10-05']);
  const later = await pay(card, 200, { transferredAt: '2026-10-06' });
  assert.equal(later.status, 409);
  assert.equal(later.json.detail.countedInStatement, false);
  const ok = await pay(card, 200, { transferredAt: '2026-10-05', confirmOverpay: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await statements(card)).prepaid, 0, '已算進 10/5 那期，不當預繳');
});
