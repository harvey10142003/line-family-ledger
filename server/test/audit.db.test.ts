// P0-3／P0-4 端到端：真的 /api/liff/* 路由＋LINE 快速修正＋真的 PostgreSQL。
//
//   LEDGER_TEST_DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/ledger_test npm --workspace server test
// 沒設就整支跳過。只接受 127.0.0.1／localhost。
//
// 情境：Shark（OWNER）、Apple（MEMBER）。Apple 有一個「個人、全家看得到明細」的帳戶，上面一筆消費。
// - Shark 看交易列表 → 記一筆「Shark 看了 Apple 的個人明細」；10 分鐘內再看不重記。Apple 看自己的不記。
// - Shark 匯出 → EXPORT_CSV＋看到 Apple 明細（每次都記）。
// - Apple 改帳戶可見範圍 → PERMISSION_CHANGE；改、刪自己的交易 → EDIT／DELETE（與資料同交易）。
// - LINE 快速修正刪交易 → DELETE（channel LINE）；加入家庭 → MEMBER_JOIN。
// - 真實姓名：沒金鑰 503 且資料庫沒動、沒寫稽核；有金鑰只存密文、只回遮罩、寫稽核。
// - 「我的被存取紀錄」：Apple 看得到 Shark 對她的檢視與匯出；Shark 的 family 範圍看不到 Apple 對她自己個人帳戶的操作。
// - 資料庫 trigger：AuditLog 的 UPDATE／DELETE 被拒絕。
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
const FAM = `fam_au_${RUN}`;
const SHARK = `ms_au_${RUN}`;
const APPLE = `ma_au_${RUN}`;
const U_SHARK = `U_shark_au_${RUN}`;
const U_APPLE = `U_apple_au_${RUN}`;
const MONTH = '2026-10';
const PAID_AT = new Date('2026-10-15T04:00:00Z');
const KEY = randomBytes(32).toString('hex');
const NAME = '施允瀚';

let prisma: any;
let audit: typeof import('../src/services/audit');
let base = '';
let server: any;
let appleAcc = '';
let appleTx = '';
let appleTx2 = '';
let sharedTx = '';
const replies: any[] = [];

async function call(who: 'shark' | 'apple', method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api/liff${path}`, {
    method,
    headers: { authorization: `Bearer tok-${who}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* CSV */
  }
  return { status: r.status, json, text };
}

const rows = (where: Record<string, unknown> = {}) => prisma.auditLog.findMany({ where: { familyId: FAM, ...where }, orderBy: { createdAt: 'asc' } });

before(async () => {
  if (SKIP) return;
  process.env.DATABASE_URL = DB_URL;
  process.env.LINE_LOGIN_CHANNEL_ID = CHANNEL;
  process.env.LINE_CHANNEL_SECRET ??= 'test-secret';
  process.env.LINE_CHANNEL_ACCESS_TOKEN ??= 'test-token';
  process.env.LINE_LIFF_ID ??= `${CHANNEL}-test`;
  process.env.GEMINI_API_KEY ??= 'test-gemini';
  delete process.env.LEDGER_FIELD_KEY;

  ({ prisma } = await import('../src/prisma'));
  audit = await import('../src/services/audit');
  await audit.ensureAuditAppendOnly();
  audit.resetViewDedupeForTest();
  const { buildLiffRouter } = await import('../src/routes/liff');
  const { createLiffAuth } = await import('../src/lib/liff-auth');
  const { lineClient } = await import('../src/line/client');
  (lineClient as any).replyMessage = async (req: any) => {
    replies.push(req);
    return {};
  };

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

  await prisma.family.create({ data: { id: FAM, name: '稽核測試家', familyCode: `Q${RUN.slice(0, 5).toUpperCase()}`, ownerLineId: U_SHARK } });
  await prisma.familyMember.createMany({
    data: [
      { id: SHARK, familyId: FAM, lineUserId: U_SHARK, displayName: 'Shark', role: 'OWNER' },
      { id: APPLE, familyId: FAM, lineUserId: U_APPLE, displayName: 'Apple', role: 'MEMBER' },
    ],
  });
  const cat = await prisma.category.create({ data: { familyId: FAM, name: '餐飲', type: 'EXPENSE', isDefault: true, sortOrder: 1 } });
  await prisma.account.create({ data: { familyId: FAM, name: '電子錢包', type: 'EPAYMENT', sortOrder: 99 } });
  const acc = await prisma.account.create({ data: { familyId: FAM, name: 'Apple 的台新', type: 'BANK', ownerMemberId: APPLE, visibility: 'FAMILY_FULL' } });
  appleAcc = acc.id;
  const mk = (memberId: string, accountId: string | null, amount: number) =>
    prisma.transaction.create({ data: { familyId: FAM, memberId, categoryId: cat.id, accountId, amount, note: '午餐', paidAt: PAID_AT } });
  appleTx = (await mk(APPLE, appleAcc, 120)).id;
  appleTx2 = (await mk(APPLE, appleAcc, 80)).id;
  sharedTx = (await mk(SHARK, null, 300)).id;
});

after(async () => {
  if (SKIP) return;
  await new Promise<void>((r) => server.close(() => r()));
  // AuditLog 只加不改（trigger 擋刪除）：測試留下的紀錄就留在拋棄式測試庫
  await prisma.transaction.deleteMany({ where: { familyId: FAM } });
  await prisma.account.deleteMany({ where: { familyId: FAM } });
  await prisma.category.deleteMany({ where: { familyId: FAM } });
  await prisma.familyMember.deleteMany({ where: { familyId: FAM } });
  await prisma.family.delete({ where: { id: FAM } });
  await prisma.$disconnect();
});

test('看別人的個人明細：記一筆、10 分鐘內不重記；看自己的不記', { skip: SKIP }, async () => {
  assert.equal((await call('shark', 'GET', `/transactions?month=${MONTH}`)).status, 200);
  assert.equal((await call('shark', 'GET', `/transactions?month=${MONTH}`)).status, 200);
  assert.equal((await call('apple', 'GET', `/transactions?month=${MONTH}`)).status, 200);
  const views = await rows({ action: 'VIEW_PERSONAL', targetType: 'TRANSACTION_LIST' });
  assert.equal(views.length, 1, '只記 Shark 看 Apple 那一次');
  assert.equal(views[0].actorMemberId, SHARK);
  assert.equal(views[0].subjectMemberId, APPLE);
  assert.equal(views[0].channel, 'LIFF');
  assert.deepEqual(views[0].detail, { month: MONTH, count: 2 });
});

test('匯出：先寫 EXPORT_CSV 才給檔，並記看到誰的明細（不去重）', { skip: SKIP }, async () => {
  for (let i = 0; i < 2; i++) {
    const r = await call('shark', 'GET', `/export?month=${MONTH}`);
    assert.equal(r.status, 200);
    assert.match(r.text, /午餐/);
  }
  const ex = await rows({ action: 'EXPORT_CSV' });
  assert.equal(ex.length, 2);
  assert.deepEqual(ex[0].detail, { month: MONTH, rows: 3 });
  assert.equal((await rows({ action: 'VIEW_PERSONAL', targetType: 'EXPORT', subjectMemberId: APPLE })).length, 2);
});

test('權限變更與一般修改：可見範圍改了＝PERMISSION_CHANGE，只改名＝EDIT', { skip: SKIP }, async () => {
  assert.equal((await call('apple', 'PUT', `/accounts/${appleAcc}`, { visibility: 'FAMILY_TOTAL_ONLY' })).status, 200);
  assert.equal((await call('apple', 'PUT', `/accounts/${appleAcc}`, { name: 'Apple 台新' })).status, 200);
  const r = await rows({ targetType: 'ACCOUNT', targetId: appleAcc });
  assert.deepEqual(
    r.map((x: any) => x.action),
    ['PERMISSION_CHANGE', 'EDIT'],
  );
  assert.equal(r[0].subjectMemberId, APPLE);
  assert.equal(r[0].detail.visibilityBefore, 'FAMILY_FULL');
  assert.equal(r[0].detail.visibilityAfter, 'FAMILY_TOTAL_ONLY');
  assert.deepEqual(r[1].detail, { fields: ['name'] });
  // 改回來，讓後面的測試照原設定
  await call('apple', 'PUT', `/accounts/${appleAcc}`, { visibility: 'FAMILY_FULL' });
});

test('改、刪交易（LIFF）：跟資料一起寫進稽核；權限不符的不記', { skip: SKIP }, async () => {
  assert.equal((await call('apple', 'PATCH', `/transactions/${appleTx}`, { amount: 150, note: '晚餐' })).status, 200);
  assert.equal((await call('shark', 'PATCH', `/transactions/${appleTx}`, { amount: 1 })).status, 403, 'D10：別人個人帳戶上的不能改');
  assert.equal((await call('shark', 'DELETE', `/transactions/${sharedTx}`)).status, 200);
  const edit = await rows({ action: 'EDIT', targetType: 'TRANSACTION' });
  assert.equal(edit.length, 1);
  assert.equal(edit[0].subjectMemberId, APPLE);
  assert.deepEqual(edit[0].detail, { fields: ['amount', 'note'] });
  assert.ok(!JSON.stringify(edit[0]).includes('晚餐'), '備註內容不進稽核');
  const del = await rows({ action: 'DELETE', targetType: 'TRANSACTION', targetId: sharedTx });
  assert.equal(del.length, 1);
  assert.equal(del[0].subjectMemberId, null, '共同的＝null');
  assert.deepEqual(del[0].detail, { amount: 300, paidAt: '2026-10-15' });
});

test('LINE 快速修正刪交易、加入家庭：channel LINE', { skip: SKIP }, async () => {
  const { handleQuickFix } = await import('../src/line/handlers/quick-fix');
  assert.equal(await handleQuickFix(U_APPLE, 'rt', 'del_tx', new URLSearchParams({ tx: appleTx2 })), true);
  assert.equal(await prisma.transaction.count({ where: { id: appleTx2 } }), 0);
  const del = await rows({ action: 'DELETE', targetId: appleTx2 });
  assert.equal(del.length, 1);
  assert.equal(del[0].channel, 'LINE');
  assert.equal(del[0].actorMemberId, APPLE);
  assert.equal(del[0].subjectMemberId, APPLE);

  const { joinFamily } = await import('../src/services/family');
  const fam = await prisma.family.findUnique({ where: { id: FAM } });
  const joined: any = await joinFamily({ familyCode: fam.familyCode, lineUserId: `U_kid_${RUN}`, displayName: '小孩' });
  assert.ok(joined.member);
  const j = await rows({ action: 'MEMBER_JOIN' });
  assert.equal(j.length, 1);
  assert.equal(j[0].targetId, joined.member.id);
});

test('真實姓名：沒金鑰 503 且不寫入；有金鑰只存密文、只回遮罩、寫稽核；清除也記', { skip: SKIP }, async () => {
  delete process.env.LEDGER_FIELD_KEY;
  const blocked = await call('shark', 'PUT', '/me/legal-name', { legalName: NAME });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.json.code, 'field_key_unavailable');
  assert.equal((await prisma.familyMember.findUnique({ where: { id: SHARK } })).legalNameEnc, null);
  assert.equal((await rows({ action: 'LEGAL_NAME_SET' })).length, 0);

  process.env.LEDGER_FIELD_KEY = KEY;
  assert.equal((await call('shark', 'PUT', '/me/legal-name', { legalName: 'A123456789' })).status, 400);
  const ok = await call('shark', 'PUT', '/me/legal-name', { legalName: NAME });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { registered: true, masked: '施＊瀚' });
  assert.ok(!ok.text.includes(NAME));
  const enc = (await prisma.familyMember.findUnique({ where: { id: SHARK } })).legalNameEnc as string;
  assert.match(enc, /^lfe:v1:/);
  assert.ok(!enc.includes(NAME));
  // 解得開、而且綁在 Shark 這一列
  const { readLegalNamePlain } = await import('../src/services/legal-name');
  assert.equal(await readLegalNamePlain(SHARK), NAME);
  // Apple 看到的是她自己的（沒登記），看不到 Shark 的
  assert.deepEqual((await call('apple', 'GET', '/me/legal-name')).json, { registered: false });
  assert.deepEqual((await call('shark', 'GET', '/me/legal-name')).json, { registered: true, masked: '施＊瀚' });
  // 金鑰拿掉：讀回「已登記但暫時看不到」，不是假裝沒登記
  delete process.env.LEDGER_FIELD_KEY;
  assert.deepEqual((await call('shark', 'GET', '/me/legal-name')).json, { registered: true, masked: null, unavailable: 'key' });
  process.env.LEDGER_FIELD_KEY = KEY;
  assert.equal((await call('shark', 'PUT', '/me/legal-name', { legalName: null })).status, 200);
  assert.equal((await prisma.familyMember.findUnique({ where: { id: SHARK } })).legalNameEnc, null);
  assert.deepEqual(
    (await rows({ targetType: 'MEMBER', targetId: SHARK })).map((x: any) => x.action),
    ['LEGAL_NAME_SET', 'LEGAL_NAME_CLEAR'],
  );
  for (const r of await rows({ targetId: SHARK })) assert.ok(!JSON.stringify(r).includes(NAME));
});

test('金鑰輪替：v1 密文用 v2 重加密，換完只留新鑰也解得開，每列寫一筆 FIELD_KEY_ROTATE', { skip: SKIP }, async () => {
  const { rotateFieldKeys } = await import('../src/services/field-key-rotation');
  const { readLegalNamePlain } = await import('../src/services/legal-name');
  process.env.LEDGER_FIELD_KEY = KEY;
  process.env.LEDGER_FIELD_KEY_VERSION = '1';
  assert.equal((await call('apple', 'PUT', '/me/legal-name', { legalName: '王小美' })).status, 200);
  const K2 = randomBytes(32).toString('hex');
  process.env.LEDGER_FIELD_KEY = K2;
  process.env.LEDGER_FIELD_KEY_VERSION = '2';
  process.env.LEDGER_FIELD_KEYS_OLD = `1:${KEY}`;
  try {
    const dry = await rotateFieldKeys({ dryRun: true });
    assert.ok(dry.needed >= 1);
    assert.equal(dry.rotated, 0);
    const run = await rotateFieldKeys();
    assert.equal(run.failed, 0);
    assert.equal(run.rotated, dry.needed);
    assert.equal((await rotateFieldKeys({ dryRun: true })).needed, 0);
    delete process.env.LEDGER_FIELD_KEYS_OLD;
    assert.equal(await readLegalNamePlain(APPLE), '王小美');
    assert.match((await prisma.familyMember.findUnique({ where: { id: APPLE } })).legalNameEnc, /^lfe:v2:/);
    const rot = await rows({ action: 'FIELD_KEY_ROTATE', targetId: APPLE });
    assert.equal(rot.length, 1);
    assert.equal(rot[0].channel, 'SYSTEM');
    assert.equal(rot[0].actorMemberId, null);
  } finally {
    process.env.LEDGER_FIELD_KEY = KEY;
    process.env.LEDGER_FIELD_KEY_VERSION = '1';
    delete process.env.LEDGER_FIELD_KEYS_OLD;
    await prisma.familyMember.update({ where: { id: APPLE }, data: { legalNameEnc: null } });
  }
});

test('我的被存取紀錄：mine 只有別人對我的；family 不含別人對他自己個人東西的操作', { skip: SKIP }, async () => {
  const mineA = (await call('apple', 'GET', '/audit-log?scope=mine')).json.items;
  assert.ok(mineA.length >= 3);
  assert.ok(mineA.every((x: any) => x.aboutMe && !x.isMine && x.actorName === 'Shark'));
  assert.ok(mineA.some((x: any) => x.action === 'VIEW_PERSONAL' && x.targetType === 'TRANSACTION_LIST'));
  assert.ok(mineA.some((x: any) => x.action === 'VIEW_PERSONAL' && x.targetType === 'EXPORT'));

  const famS = (await call('shark', 'GET', '/audit-log?scope=family')).json.items;
  assert.ok(famS.some((x: any) => x.action === 'DELETE' && x.targetId === sharedTx), '共同的刪除大家看得到');
  assert.ok(!famS.some((x: any) => x.targetId === appleAcc), 'Apple 改她自己個人帳戶的權限，Shark 看不到');
  assert.ok(!famS.some((x: any) => x.targetId === appleTx2), 'Apple 刪她自己個人帳戶上的交易，Shark 看不到');
  const famA = (await call('apple', 'GET', '/audit-log?scope=family')).json.items;
  assert.ok(!famA.some((x: any) => x.action === 'LEGAL_NAME_SET' && x.targetId === SHARK), 'Shark 登記真實姓名，Apple 看不到');
});

test('資料庫層只加不改：UPDATE／DELETE AuditLog 被 trigger 拒絕', { skip: SKIP }, async () => {
  const n = (await rows()).length;
  await assert.rejects(prisma.auditLog.updateMany({ where: { familyId: FAM }, data: { action: 'X' } }), /append-only/);
  await assert.rejects(prisma.auditLog.deleteMany({ where: { familyId: FAM } }), /append-only/);
  await assert.rejects(prisma.$executeRawUnsafe('TRUNCATE "AuditLog"'), /append-only/);
  assert.equal((await rows()).length, n);
  await audit.ensureAuditAppendOnly(); // 重複執行沒關係
});

test('匯出：稽核寫不進去就不給檔（fail-closed）', { skip: SKIP }, async () => {
  const orig = prisma.auditLog.create;
  prisma.auditLog.create = async () => {
    throw new Error('db down');
  };
  try {
    const r = await call('shark', 'GET', `/export?month=${MONTH}`);
    assert.equal(r.status, 503);
    assert.ok(!r.text.includes('午餐'));
  } finally {
    prisma.auditLog.create = orig;
  }
});
