// MED-1（11-06 QA）：繳卡費找不到可沖的帳單時，錢不能從淨資產消失。
// 走真的 /api/liff/* 路由＋真的 PostgreSQL（同 finance-transfer-liability.db.test.ts）。
//   LEDGER_TEST_DATABASE_URL=postgresql://user@127.0.0.1:5432/ledger_test npm --workspace server test
// 沒設就整支跳過。只接受 127.0.0.1／localhost。
//
// 規則：
// - 卡還沒有帳單、或最近一期已繳清又再繳 → 409 no_statement_needs_confirm，什麼都不動
// - 帶 confirmOverpay 確認 → 記成這張卡的預繳（cardStatementId 留空）：來源帳戶扣錢、淨資產不變（預繳算資產＝負的未繳）
// - 之後建立新帳單 → 預繳整筆沖進去（paidAmount 增加、狀態跟著變）；淨資產＝少了這期應繳、多了預繳抵扣
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

  // 建新帳單 3000：預繳 5000 整筆沖進去 → 已繳 5000、溢繳 2000、PAID
  const st = await call('POST', `/credit-cards/${card}/statements`, { statementDate: '2026-11-05', dueDate: '2099-11-20', newBalance: 3000 });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  assert.deepEqual([st.json.paidAmount, st.json.status, st.json.overpaid, st.json.remaining], [5000, 'PAID', 2000, 0]);
  assert.equal((await prisma.transfer.findUnique({ where: { id: ok.json.id } })).cardStatementId, st.json.id);
  assert.equal((await statements(card)).prepaid, 0, '沖進帳單後就不再是預繳');
  assert.equal(await netWorth(), r2(nw0 - 3000), '多了一期 3000 的應繳（被預繳抵掉），淨資產＝原本 − 3000');

  // 同一期重送（更新金額）不會重複抵扣
  const again = await call('POST', `/credit-cards/${card}/statements`, { statementDate: '2026-11-05', dueDate: '2099-11-20', newBalance: 6000 });
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

test('最近一期已繳清又再繳：409 all_paid；確認 → 預繳算資產；下一期帳單建立時抵扣成部分已繳', { skip: SKIP }, async () => {
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

  // 下一期 2000：預繳 500 抵扣 → 部分已繳、還剩 1500
  const st2 = await call('POST', `/credit-cards/${card}/statements`, { statementDate: '2026-11-05', dueDate: '2099-11-20', newBalance: 2000 });
  assert.deepEqual([st2.json.paidAmount, st2.json.status, st2.json.remaining], [500, 'PARTIAL', 1500]);
  assert.equal((await statements(card)).prepaid, 0);
  assert.equal(await netWorth(), r2(nw0 - 2000), '帳戶已經少了 500；新一期 2000 被抵掉 500，還欠 1500');

  // 歷史時間點：10 月底（第二期 11/5 還沒出帳）時，那 500 仍是預繳
  const { computeForViewer } = await import('../src/services/net-worth');
  const { loadAccessScope } = await import('../src/services/access');
  const { monthEndTaipei } = await import('../src/lib/net-worth');
  const oct = await computeForViewer(FAM, await loadAccessScope(FAM, SHARK), monthEndTaipei('2026-10'));
  const octRow = oct.rows.find((x: any) => x.name === '已繳清卡');
  assert.equal(octRow?.amount, -500, JSON.stringify(oct.rows));
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
