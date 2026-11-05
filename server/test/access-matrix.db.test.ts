// 可見範圍與編輯權限：走真的 /api/liff/* 路由＋真的 PostgreSQL 的端到端矩陣。
//
// 需要一個「拋棄式」本機資料庫（已 prisma db push 過）：
//   LEDGER_TEST_DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/ledger_test npm --workspace server test
// 沒設就整支跳過（純邏輯矩陣在 access-policy.test.ts，永遠會跑）。只接受 127.0.0.1／localhost，避免誤打正式庫。
//
// 兩位成員（Shark 本人／Apple 配偶）× 14 種付款工具（帳戶、信用卡各 7 種：共同、Shark 個人 ×3 可見、Apple 個人 ×3 可見）
// ×（讀明細、讀總額、改、刪），再加上帳戶／卡本身的列出與修改、轉帳、記到該帳戶、匯出、月報推播。
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
const FAM = `fam_${RUN}`;
const SHARK = `ms_${RUN}`;
const APPLE = `ma_${RUN}`;
const MONTH = '2026-10';
const PAID_AT = new Date('2026-10-15T04:00:00Z');

const INSTRUMENTS = [
  { key: 'joint', owner: null, vis: 'FAMILY_FULL' },
  { key: 'shark_full', owner: SHARK, vis: 'FAMILY_FULL' },
  { key: 'shark_total', owner: SHARK, vis: 'FAMILY_TOTAL_ONLY' },
  { key: 'shark_owner', owner: SHARK, vis: 'OWNER_ONLY' },
  { key: 'apple_full', owner: APPLE, vis: 'FAMILY_FULL' },
  { key: 'apple_total', owner: APPLE, vis: 'FAMILY_TOTAL_ONLY' },
  { key: 'apple_owner', owner: APPLE, vis: 'OWNER_ONLY' },
] as const;
type Key = (typeof INSTRUMENTS)[number]['key'];

// 期望（逐格手寫）：讀明細 / 算進總額 / 改（HTTP 狀態）/ 刪（HTTP 狀態）
type Exp = { detail: boolean; total: boolean; edit: number; del: number };
const E = (detail: boolean, total: boolean, edit: number, del: number): Exp => ({ detail, total, edit, del });
const EXPECTED: Record<'shark' | 'apple', Record<Key, Exp>> = {
  shark: {
    joint: E(true, true, 200, 200),
    shark_full: E(true, true, 200, 200),
    shark_total: E(true, true, 200, 200),
    shark_owner: E(true, true, 200, 200),
    apple_full: E(true, true, 403, 403),
    apple_total: E(false, true, 404, 404),
    apple_owner: E(false, false, 404, 404),
  },
  apple: {
    joint: E(true, true, 200, 200),
    shark_full: E(true, true, 403, 403),
    shark_total: E(false, true, 404, 404),
    shark_owner: E(false, false, 404, 404),
    apple_full: E(true, true, 200, 200),
    apple_total: E(true, true, 200, 200),
    apple_owner: E(true, true, 200, 200),
  },
};

// 帳戶／卡「本身」的寫入：只看總額的帳戶仍會列出（知道它存在），所以是 403；完全看不到的才是 404
const accWrite = (e: Exp) => (e.edit === 200 ? 200 : e.total ? 403 : 404);

// 每個工具一筆 2 的次方金額 → 總額是位元遮罩，看得出到底加了哪幾筆
const amountOf = (kind: 'acc' | 'card', i: number) => 2 ** (i + (kind === 'card' ? 7 : 0));

let prisma: any;
let base = '';
let server: any;
let catId = '';
const ids: Record<string, string> = {}; // `${kind}:${key}` → 帳戶／卡 id
const txIds: Record<string, string> = {}; // `${kind}:${key}` → 交易 id
const pushes: { to: string[]; messages: any[] }[] = [];

function tokenOf(who: 'shark' | 'apple') {
  return who === 'shark' ? 'tok-shark' : 'tok-apple';
}

async function call(who: 'shark' | 'apple', method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api/liff${path}`, {
    method,
    headers: { authorization: `Bearer ${tokenOf(who)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
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
  const { lineClient } = await import('../src/line/client');
  (lineClient as any).multicast = async (req: { to: string[]; messages: any[] }) => {
    pushes.push(req);
    return {};
  };

  const subs: Record<string, string> = { 'tok-shark': `U_shark_${RUN}`, 'tok-apple': `U_apple_${RUN}` };
  const fakeFetch = (async (_url: any, init?: any) => {
    const p = new URLSearchParams(String(init?.body ?? ''));
    const sub = subs[p.get('id_token') ?? ''];
    const json = sub
      ? { sub, aud: CHANNEL, exp: Math.floor(Date.now() / 1000) + 3600 }
      : { error: 'invalid_request', error_description: 'Invalid IdToken.' };
    return new Response(JSON.stringify(json), { status: sub ? 200 : 400, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/liff', buildLiffRouter(createLiffAuth({ channelId: CHANNEL, fetchImpl: fakeFetch })));
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // ---- 假資料 ----
  await prisma.family.create({ data: { id: FAM, name: '權限測試家', familyCode: RUN.slice(0, 6).toUpperCase(), ownerLineId: subs['tok-shark'] } });
  await prisma.familyMember.createMany({
    data: [
      { id: SHARK, familyId: FAM, lineUserId: subs['tok-shark'], displayName: 'Shark', role: 'OWNER' },
      { id: APPLE, familyId: FAM, lineUserId: subs['tok-apple'], displayName: 'Apple', role: 'MEMBER' },
    ],
  });
  const cat = await prisma.category.create({ data: { familyId: FAM, name: '餐飲', type: 'EXPENSE', isDefault: true, sortOrder: 1 } });
  catId = cat.id;
  // 先放一個共同的電子錢包，讓 ensureDefaultAccounts 不另外補建
  await prisma.account.create({ data: { familyId: FAM, name: '電子錢包', type: 'EPAYMENT', sortOrder: 99 } });

  for (const [i, it] of INSTRUMENTS.entries()) {
    const own = it.owner ? { ownerMemberId: it.owner, visibility: it.vis } : {};
    const acc = await prisma.account.create({ data: { familyId: FAM, name: `帳戶-${it.key}`, type: 'BANK', sortOrder: i, isDefault: it.key === 'apple_full', ...own } });
    const card = await prisma.creditCard.create({ data: { familyId: FAM, name: `卡-${it.key}`, creditLimit: 50000, statementDay: 1, dueDay: 15, sortOrder: i, ...own } });
    ids[`acc:${it.key}`] = acc.id;
    ids[`card:${it.key}`] = card.id;
    // 記錄者＝工具本人（共同的由 Shark 記）
    const memberId = it.owner ?? SHARK;
    const ta = await prisma.transaction.create({
      data: { familyId: FAM, memberId, categoryId: catId, accountId: acc.id, amount: amountOf('acc', i), note: `明細-acc-${it.key}`, paidAt: PAID_AT },
    });
    const tc = await prisma.transaction.create({
      data: { familyId: FAM, memberId, categoryId: catId, creditCardId: card.id, amount: amountOf('card', i), note: `明細-card-${it.key}`, paidAt: PAID_AT },
    });
    txIds[`acc:${it.key}`] = ta.id;
    txIds[`card:${it.key}`] = tc.id;
  }
});

after(async () => {
  if (SKIP) return;
  await new Promise<void>((r) => server.close(() => r()));
  // 依外鍵順序清掉這次的假資料
  await prisma.transfer.deleteMany({ where: { familyId: FAM } });
  await prisma.recurringRule.deleteMany({ where: { familyId: FAM } });
  await prisma.transaction.deleteMany({ where: { familyId: FAM } });
  await prisma.account.deleteMany({ where: { familyId: FAM } });
  await prisma.creditCard.deleteMany({ where: { familyId: FAM } });
  await prisma.category.deleteMany({ where: { familyId: FAM } });
  await prisma.familyMember.deleteMany({ where: { familyId: FAM } });
  await prisma.family.delete({ where: { id: FAM } });
  await prisma.$disconnect();
});

function expectedMask(who: 'shark' | 'apple', pick: 'detail' | 'total') {
  let m = 0;
  for (const [i, it] of INSTRUMENTS.entries()) {
    if (EXPECTED[who][it.key][pick]) m += amountOf('acc', i) + amountOf('card', i);
  }
  return m;
}

test('交易矩陣：2 成員 × 14 種付款工具 × 讀明細／讀總額／改／刪（真路由＋真 PG）', { skip: SKIP }, async () => {
  const report: string[] = [];
  for (const who of ['shark', 'apple'] as const) {
    const list = await call(who, 'GET', `/transactions?month=${MONTH}`);
    assert.equal(list.status, 200);
    const listed = new Set(list.json.items.map((t: any) => t.id));
    const sum = await call(who, 'GET', `/summary?month=${MONTH}`);
    assert.equal(sum.status, 200);
    // 總額＝期望會算進去的那幾筆（2 的次方位元遮罩，一格都不能多不能少）
    assert.equal(sum.json.totalExpense, expectedMask(who, 'total'), `${who} summary total`);
    // 明細列表合計＝期望看得到明細的那幾筆
    const listedSum = list.json.items.reduce((s: number, t: any) => s + t.amount, 0);
    assert.equal(listedSum, expectedMask(who, 'detail'), `${who} transactions detail sum`);

    for (const kind of ['acc', 'card'] as const) {
      for (const it of INSTRUMENTS) {
        const exp = EXPECTED[who][it.key];
        const txId = txIds[`${kind}:${it.key}`];
        const detail = listed.has(txId);
        assert.equal(detail, exp.detail, `${who} ${kind}:${it.key} detail`);
        const row = list.json.items.find((t: any) => t.id === txId);
        if (row) assert.equal(row.canEdit, exp.edit === 200, `${who} ${kind}:${it.key} canEdit flag`);

        const edit = await call(who, 'PATCH', `/transactions/${txId}`, { note: `改-${who}` });
        assert.equal(edit.status, exp.edit, `${who} ${kind}:${it.key} edit`);
        const after = await prisma.transaction.findUnique({ where: { id: txId } });
        assert.equal(after.note === `改-${who}`, exp.edit === 200, `${who} ${kind}:${it.key} edit persisted?`);
        await prisma.transaction.update({ where: { id: txId }, data: { note: `明細-${kind}-${it.key}` } });

        // 刪：用同一工具上的臨時交易測，不動矩陣資料
        const tmp = await prisma.transaction.create({
          data: {
            familyId: FAM,
            memberId: it.owner ?? SHARK,
            categoryId: catId,
            ...(kind === 'acc' ? { accountId: ids[`acc:${it.key}`] } : { creditCardId: ids[`card:${it.key}`] }),
            amount: 1,
            paidAt: new Date('2026-09-01T04:00:00Z'),
          },
        });
        const del = await call(who, 'DELETE', `/transactions/${tmp.id}`);
        assert.equal(del.status, exp.del, `${who} ${kind}:${it.key} delete`);
        const still = await prisma.transaction.findUnique({ where: { id: tmp.id } });
        assert.equal(still === null, exp.del === 200, `${who} ${kind}:${it.key} delete persisted?`);
        if (still) await prisma.transaction.delete({ where: { id: tmp.id } });

        report.push(
          `${who.padEnd(6)}${`${kind}:${it.key}`.padEnd(18)}明細=${detail ? 'Y' : 'N'} 總額=${exp.total ? 'Y' : 'N'} 改=${edit.status} 刪=${del.status}`,
        );
      }
    }
  }
  console.log(report.join('\n'));
});

test('帳戶／卡本身：列出、只看總額的標示、修改權限（D10）', { skip: SKIP }, async () => {
  for (const who of ['shark', 'apple'] as const) {
    const accs = await call(who, 'GET', '/accounts');
    const cards = await call(who, 'GET', '/credit-cards');
    assert.equal(accs.status, 200);
    assert.equal(cards.status, 200);
    for (const it of INSTRUMENTS) {
      const exp = EXPECTED[who][it.key];
      const listedAcc = accs.json.accounts.find((a: any) => a.id === ids[`acc:${it.key}`]);
      const listedCard = cards.json.cards.find((c: any) => c.id === ids[`card:${it.key}`]);
      // 只要算得進總額就列出（只看總額的列餘額）；完全看不到的不列
      assert.equal(!!listedAcc, exp.total, `${who} list acc:${it.key}`);
      assert.equal(!!listedCard, exp.total, `${who} list card:${it.key}`);
      if (listedAcc) {
        assert.equal(listedAcc.access, exp.detail ? 'DETAIL' : 'TOTAL');
        assert.equal(listedAcc.canEdit, exp.edit === 200);
        assert.equal(typeof listedAcc.balance, 'number');
      }
      const putAcc = await call(who, 'PUT', `/accounts/${ids[`acc:${it.key}`]}`, { icon: null });
      assert.equal(putAcc.status, accWrite(exp), `${who} PUT acc:${it.key}`);
      const putCard = await call(who, 'PUT', `/credit-cards/${ids[`card:${it.key}`]}`, { creditLimit: 50000 });
      assert.equal(putCard.status, accWrite(exp), `${who} PUT card:${it.key}`);
    }
  }
});

test('記到某帳戶／卡、從某帳戶轉出：只有共同或自己的', { skip: SKIP }, async () => {
  for (const who of ['shark', 'apple'] as const) {
    for (const it of INSTRUMENTS) {
      const exp = EXPECTED[who][it.key];
      const post = await call(who, 'POST', '/transactions', { categoryId: catId, amount: 1, paidAt: '2026-09-02', accountId: ids[`acc:${it.key}`] });
      assert.equal(post.status, accWrite(exp), `${who} POST tx to acc:${it.key}`);
      const postCard = await call(who, 'POST', '/transactions', { categoryId: catId, amount: 1, paidAt: '2026-09-02', creditCardId: ids[`card:${it.key}`] });
      assert.equal(postCard.status, accWrite(exp), `${who} POST tx to card:${it.key}`);

      // 從該帳戶轉到共同帳戶
      if (it.key !== 'joint') {
        const out = await call(who, 'POST', '/transfers', { fromAccountId: ids[`acc:${it.key}`], toAccountId: ids['acc:joint'], amount: 1 });
        assert.equal(out.status, accWrite(exp), `${who} transfer out of acc:${it.key}`);
        // 從共同帳戶轉進該帳戶：看得到（明細或總額）就可以，完全看不到 → 404
        const into = await call(who, 'POST', '/transfers', { fromAccountId: ids['acc:joint'], toAccountId: ids[`acc:${it.key}`], amount: 1 });
        assert.equal(into.status, exp.total ? 200 : 404, `${who} transfer into acc:${it.key}`);
      }
    }
  }
  await prisma.transaction.deleteMany({ where: { familyId: FAM, paidAt: { lt: new Date('2026-10-01T00:00:00Z') } } });
});

test('轉帳列表：看不到的帳戶名稱遮掉；兩端都不是明細的不列', { skip: SKIP }, async () => {
  await prisma.transfer.deleteMany({ where: { familyId: FAM } });
  const mk = (from: Key, to: Key) =>
    prisma.transfer.create({
      data: { familyId: FAM, memberId: SHARK, fromAccountId: ids[`acc:${from}`], toAccountId: ids[`acc:${to}`], amount: 7, transferredAt: PAID_AT },
    });
  const t1 = await mk('joint', 'shark_owner');
  const t2 = await mk('shark_total', 'shark_owner');
  const apple = await call('apple', 'GET', `/transfers?month=${MONTH}`);
  const shark = await call('shark', 'GET', `/transfers?month=${MONTH}`);
  const a1 = apple.json.items.find((x: any) => x.id === t1.id);
  assert.ok(a1, 'apple sees joint→shark_owner');
  assert.equal(a1.toName, '不公開帳戶');
  assert.equal(apple.json.items.some((x: any) => x.id === t2.id), false, 'apple does not see shark_total→shark_owner');
  assert.equal(shark.json.items.find((x: any) => x.id === t1.id).toName, '帳戶-shark_owner');
  assert.ok(shark.json.items.some((x: any) => x.id === t2.id));
  await prisma.transfer.deleteMany({ where: { familyId: FAM } });
});

test('匯出 CSV 只含看得到明細的；分帳、趨勢、預算不含看不到的', { skip: SKIP }, async () => {
  for (const who of ['shark', 'apple'] as const) {
    const csv = await call(who, 'GET', `/export?month=${MONTH}`);
    assert.equal(csv.status, 200);
    for (const it of INSTRUMENTS) {
      const exp = EXPECTED[who][it.key];
      assert.equal(String(csv.json).includes(`明細-acc-${it.key}`), exp.detail, `${who} csv acc:${it.key}`);
    }
    const trend = await call(who, 'GET', '/trend?months=12');
    const oct = trend.json.trend.find((x: any) => x.month === MONTH);
    if (oct) assert.equal(oct.expense, expectedMask(who, 'total'), `${who} trend`);
    const st = await call(who, 'GET', `/settlement?month=${MONTH}`);
    assert.equal(st.json.totalExpense, expectedMask(who, 'total'), `${who} settlement`);
    const bs = await call(who, 'GET', `/budget-status?month=${MONTH}`);
    assert.equal(bs.status, 200);
    // 只看總額的帳戶在分類圓餅裡併成一塊、不露分類
    const sum = await call(who, 'GET', `/summary?month=${MONTH}`);
    const bucket = sum.json.byCategory.find((c: any) => c.name === '其他成員個人帳戶');
    const totalOnlyMask = INSTRUMENTS.reduce(
      (m, it, i) => m + (EXPECTED[who][it.key].total && !EXPECTED[who][it.key].detail ? amountOf('acc', i) + amountOf('card', i) : 0),
      0,
    );
    assert.equal(bucket?.amount ?? 0, totalOnlyMask, `${who} total-only bucket`);
  }
});

test('固定收支：別人的個人帳戶不能建規則；看不到明細的規則不列', { skip: SKIP }, async () => {
  for (const who of ['shark', 'apple'] as const) {
    for (const it of INSTRUMENTS) {
      const exp = EXPECTED[who][it.key];
      const r = await call(who, 'POST', '/recurring', { categoryId: catId, amount: 99, accountId: ids[`acc:${it.key}`] });
      assert.equal(r.status, accWrite(exp), `${who} recurring on acc:${it.key}`);
    }
  }
  const sharkRules = await call('shark', 'GET', '/recurring');
  const appleRules = await call('apple', 'GET', '/recurring');
  // Shark 建了 4 條（共同＋自己 3），Apple 建了 4 條
  const visibleTo = (who: 'shark' | 'apple', rules: any[]) =>
    rules.map((x) => INSTRUMENTS.find((it) => ids[`acc:${it.key}`] === x.accountId)!.key).sort();
  assert.deepEqual(visibleTo('shark', sharkRules.json.rules), ['apple_full', 'joint', 'joint', 'shark_full', 'shark_owner', 'shark_total'].sort());
  assert.deepEqual(visibleTo('apple', appleRules.json.rules), ['apple_full', 'apple_owner', 'apple_total', 'joint', 'joint', 'shark_full'].sort());
  await prisma.recurringRule.deleteMany({ where: { familyId: FAM } });
});

test('歸屬只能設成自己或共同；不能指定給對方', { skip: SKIP }, async () => {
  const mine = await call('shark', 'POST', '/accounts', { name: `新個人-${RUN}`, type: 'BANK', ownerMemberId: SHARK });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.ownerMemberId, SHARK);
  assert.equal(mine.json.visibility, 'FAMILY_TOTAL_ONLY'); // D2 預設
  const forOther = await call('shark', 'POST', '/accounts', { name: `給對方-${RUN}`, ownerMemberId: APPLE });
  assert.equal(forOther.status, 403);
  const claimOthers = await call('apple', 'PUT', `/accounts/${mine.json.id}`, { ownerMemberId: APPLE });
  assert.equal(claimOthers.status, 403);
  const hide = await call('shark', 'PUT', `/accounts/${mine.json.id}`, { visibility: 'OWNER_ONLY' });
  assert.equal(hide.status, 200);
  const appleList = await call('apple', 'GET', '/accounts');
  assert.equal(appleList.json.accounts.some((a: any) => a.id === mine.json.id), false);
  await prisma.account.delete({ where: { id: mine.json.id } });
});

test('月報推播：每人收到自己可見範圍的數字；Apple 的月報不含 Shark 的 OWNER_ONLY', { skip: SKIP }, async () => {
  const { sendMonthlySummaries } = await import('../src/jobs/reminders');
  pushes.length = 0;
  await sendMonthlySummaries(MONTH);
  const mine = pushes.filter((p) => p.to.some((u) => u.endsWith(RUN)));
  const toApple = mine.filter((p) => p.to.includes(`U_apple_${RUN}`));
  const toShark = mine.filter((p) => p.to.includes(`U_shark_${RUN}`));
  assert.equal(toApple.length, 1);
  assert.equal(toShark.length, 1);
  assert.notEqual(toApple[0], toShark[0], '內容不同時分開推');
  const fmt = (n: number) => `$${n.toLocaleString('en-US')}`;
  assert.match(toApple[0].messages[0].altText, new RegExp(`支出 \\${fmt(expectedMask('apple', 'total'))}`));
  assert.match(toShark[0].messages[0].altText, new RegExp(`支出 \\${fmt(expectedMask('shark', 'total'))}`));
  // Shark OWNER_ONLY 那兩筆（帳戶 2^3、卡 2^10）不在 Apple 的總額裡
  const sharkOwnerOnly = amountOf('acc', 3) + amountOf('card', 3);
  assert.equal(expectedMask('apple', 'total') & sharkOwnerOnly, 0);
  assert.equal(JSON.stringify(toApple[0].messages).includes('帳戶-shark_owner'), false);
});

test('全部共同（舊資料）時：兩人看到的完全一樣、全都能改，月報整家一次推', { skip: SKIP }, async () => {
  const fam2 = `${FAM}_legacy`;
  const s2 = `${SHARK}_l`;
  const a2 = `${APPLE}_l`;
  await prisma.family.create({ data: { id: fam2, name: '舊資料家', familyCode: `L${RUN.slice(0, 5)}`.toUpperCase(), ownerLineId: 'x' } });
  await prisma.familyMember.createMany({
    data: [
      { id: s2, familyId: fam2, lineUserId: `U_ls_${RUN}`, displayName: 'S' },
      { id: a2, familyId: fam2, lineUserId: `U_la_${RUN}`, displayName: 'A' },
    ],
  });
  const c2 = await prisma.category.create({ data: { familyId: fam2, name: '餐飲', type: 'EXPENSE' } });
  const acc = await prisma.account.create({ data: { familyId: fam2, name: '現金', type: 'CASH' } });
  await prisma.transaction.create({ data: { familyId: fam2, memberId: s2, categoryId: c2.id, accountId: acc.id, amount: 120, paidAt: PAID_AT } });
  await prisma.transaction.create({ data: { familyId: fam2, memberId: a2, categoryId: c2.id, amount: 80, paidAt: PAID_AT } });

  const { loadAccessScope } = await import('../src/services/access');
  const { getMonthlySummary, getMonthlyTransactions } = await import('../src/services/transaction');
  const ss = await loadAccessScope(fam2, s2);
  const sa = await loadAccessScope(fam2, a2);
  assert.deepEqual(await getMonthlySummary(fam2, MONTH, ss), await getMonthlySummary(fam2, MONTH, sa));
  const ls = await getMonthlyTransactions(fam2, MONTH, ss);
  assert.deepEqual(ls, await getMonthlyTransactions(fam2, MONTH, sa));
  assert.equal(ls.length, 2);
  assert.ok(ls.every((t: any) => t.canEdit === true));
  assert.equal((await getMonthlySummary(fam2, MONTH, ss)).byCategory.some((c) => c.name === '其他成員個人帳戶'), false);

  const { sendMonthlySummaries } = await import('../src/jobs/reminders');
  pushes.length = 0;
  await sendMonthlySummaries(MONTH);
  const legacy = pushes.filter((p) => p.to.some((u) => u.includes(`_l`) && u.endsWith(RUN)));
  assert.equal(legacy.length, 1, '全部共同 → 跟以前一樣整家一次 multicast');
  assert.deepEqual([...legacy[0].to].sort(), [`U_la_${RUN}`, `U_ls_${RUN}`].sort());

  await prisma.transaction.deleteMany({ where: { familyId: fam2 } });
  await prisma.account.deleteMany({ where: { familyId: fam2 } });
  await prisma.category.deleteMany({ where: { familyId: fam2 } });
  await prisma.familyMember.deleteMany({ where: { familyId: fam2 } });
  await prisma.family.delete({ where: { id: fam2 } });
});

test('LINE 快速修正（刪除／改共同個人）走同一層權限；聊天記帳的預設帳戶不會落到別人的個人帳戶', { skip: SKIP }, async () => {
  const { lineClient } = await import('../src/line/client');
  const replies: string[] = [];
  (lineClient as any).replyMessage = async (req: { messages: { text?: string }[] }) => {
    replies.push(String(req.messages[0]?.text ?? ''));
    return {};
  };
  const { handleQuickFix } = await import('../src/line/handlers/quick-fix');
  const mkTmp = (key: Key) =>
    prisma.transaction.create({
      data: { familyId: FAM, memberId: SHARK, categoryId: catId, accountId: ids[`acc:${key}`], amount: 1, paidAt: new Date('2026-09-03T04:00:00Z') },
    });
  const appleUid = `U_apple_${RUN}`;
  for (const it of INSTRUMENTS) {
    const exp = EXPECTED.apple[it.key];
    const tmp = await mkTmp(it.key);
    replies.length = 0;
    await handleQuickFix(appleUid, 'rt', 'del_tx', new URLSearchParams({ tx: tmp.id }));
    const gone = (await prisma.transaction.findUnique({ where: { id: tmp.id } })) === null;
    assert.equal(gone, exp.del === 200, `apple LINE del_tx on acc:${it.key}`);
    if (exp.del === 403) assert.match(replies[0], /只有本人能修改/);
    if (exp.del === 404) assert.match(replies[0], /找不到/);
    if (!gone) {
      replies.length = 0;
      await handleQuickFix(appleUid, 'rt', 'toggle_shared', new URLSearchParams({ tx: tmp.id }));
      const row = await prisma.transaction.findUnique({ where: { id: tmp.id } });
      assert.equal(row.isShared, true, `apple LINE toggle_shared blocked on acc:${it.key}`);
      await prisma.transaction.delete({ where: { id: tmp.id } });
    }
  }

  // 預設帳戶（isDefault）設在 apple_full：Shark 記帳時不能落到那裡，要往下找自己能寫的
  const { loadAccessScope } = await import('../src/services/access');
  const { resolveAccountId, findAccountIdByName } = await import('../src/services/account');
  const { resolveCreditCardId } = await import('../src/services/creditcard');
  const ss = await loadAccessScope(FAM, SHARK);
  const sa = await loadAccessScope(FAM, APPLE);
  assert.equal(await resolveAccountId(FAM, null, sa), ids['acc:apple_full']);
  const sharkDefault = await resolveAccountId(FAM, null, ss);
  assert.notEqual(sharkDefault, ids['acc:apple_full']);
  assert.ok(ss.canWriteAccount(sharkDefault!));
  assert.equal(await findAccountIdByName(FAM, '帳戶-apple_full', ss), null);
  assert.equal(await findAccountIdByName(FAM, '帳戶-apple_full', sa), ids['acc:apple_full']);
  assert.equal(await resolveCreditCardId(FAM, '卡-apple_total', ss), null);
  assert.equal(await resolveCreditCardId(FAM, '卡-shark_owner', ss), ids['card:shark_owner']);
});
