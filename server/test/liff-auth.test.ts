// LIFF ID token middleware 測試：缺 token / 偽造 / 過期 / 正確 / 只送 x-line-user-id。
// LINE verify 端點用假 fetch 取代，不打外網。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  createLiffAuth,
  authedLineUserId,
  resolveLoginChannelId,
  LINE_ID_TOKEN_VERIFY_URL,
} from '../src/lib/liff-auth';

const CHANNEL = '2010007178';
const GOOD = 'good.id.token';
const EXPIRED = 'expired.id.token';
const OTHER_CHANNEL = 'other-channel.id.token';
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

type Call = { url: string; body: string };

function fakeLine(calls: Call[], opts: { down?: boolean } = {}): typeof fetch {
  return (async (url: any, init?: any) => {
    const body = String(init?.body ?? '');
    calls.push({ url: String(url), body });
    if (opts.down) throw new Error('ECONNRESET');
    const p = new URLSearchParams(body);
    const json = (status: number, obj: unknown) =>
      new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (p.get('client_id') !== CHANNEL) return json(400, { error: 'invalid_request', error_description: 'Invalid IdToken Audience.' });
    const tok = p.get('id_token');
    if (tok === GOOD) return json(200, { iss: 'https://access.line.me', sub: 'Ualice', aud: CHANNEL, exp: NOW / 1000 + 3600, iat: NOW / 1000 });
    if (tok === EXPIRED) return json(400, { error: 'invalid_request', error_description: 'IdToken expired.' });
    // 模擬 LINE 已放行但 aud 不是本 channel（雙層檢查）
    if (tok === OTHER_CHANNEL) return json(200, { sub: 'Umallory', aud: '9999999999', exp: NOW / 1000 + 3600 });
    return json(400, { error: 'invalid_request', error_description: 'Invalid IdToken.' });
  }) as typeof fetch;
}

async function withApp(
  fetchImpl: typeof fetch,
  fn: (base: string, mw: ReturnType<typeof createLiffAuth>) => Promise<void>,
  now: () => number = () => NOW,
) {
  const app = express();
  const mw = createLiffAuth({ channelId: CHANNEL, fetchImpl, now });
  app.use('/api/liff', mw);
  app.get('/api/liff/me', (_req, res) => res.json({ userId: authedLineUserId(res) }));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, mw);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('缺 token → 401 missing_token，且不呼叫 LINE', async () => {
  const calls: Call[] = [];
  await withApp(fakeLine(calls), async (base) => {
    const r = await fetch(`${base}/api/liff/me`);
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, 'missing_token');
    const r2 = await fetch(`${base}/api/liff/me`, { headers: { authorization: 'Basic abc' } });
    assert.equal(r2.status, 401);
  });
  assert.equal(calls.length, 0);
});

test('只送 x-line-user-id（舊後門）→ 401，不再當本人', async () => {
  const calls: Call[] = [];
  await withApp(fakeLine(calls), async (base) => {
    const r = await fetch(`${base}/api/liff/me`, { headers: { 'x-line-user-id': 'Uvictim' } });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, 'missing_token');
  });
});

test('偽造 token → 401 invalid_token', async () => {
  const calls: Call[] = [];
  await withApp(fakeLine(calls), async (base) => {
    const r = await fetch(`${base}/api/liff/me`, { headers: { authorization: 'Bearer forged.token.xyz' } });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, 'invalid_token');
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, LINE_ID_TOKEN_VERIFY_URL);
  const p = new URLSearchParams(calls[0].body);
  assert.equal(p.get('client_id'), CHANNEL);
  assert.equal(p.get('id_token'), 'forged.token.xyz');
});

test('別的 channel 的 token（aud 不符）→ 401', async () => {
  await withApp(fakeLine([]), async (base) => {
    const r = await fetch(`${base}/api/liff/me`, { headers: { authorization: `Bearer ${OTHER_CHANNEL}` } });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, 'invalid_token');
  });
});

test('過期 token → 401 token_expired', async () => {
  await withApp(fakeLine([]), async (base) => {
    const r = await fetch(`${base}/api/liff/me`, { headers: { authorization: `Bearer ${EXPIRED}` } });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, 'token_expired');
  });
});

test('正確 token → 通過，userId＝sub；x-line-user-id 同時送也被忽略', async () => {
  const calls: Call[] = [];
  await withApp(fakeLine(calls), async (base) => {
    const r = await fetch(`${base}/api/liff/me`, {
      headers: { authorization: `Bearer ${GOOD}`, 'x-line-user-id': 'Uvictim' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { userId: 'Ualice' });
  });
});

test('快取：同 token 第二次不再打 LINE；超過 exp 後重新驗證', async () => {
  const calls: Call[] = [];
  let now = NOW;
  await withApp(
    fakeLine(calls),
    async (base, mw) => {
      const h = { authorization: `Bearer ${GOOD}` };
      assert.equal((await fetch(`${base}/api/liff/me`, { headers: h })).status, 200);
      assert.equal((await fetch(`${base}/api/liff/me`, { headers: h })).status, 200);
      assert.equal(calls.length, 1);
      // 快取 key 是雜湊，不存明文 token
      assert.ok(![...mw._cache.keys()].includes(GOOD));
      // 快取存活不超過 exp（exp＝NOW+3600s，TTL 預設 300s → 取 300s）
      now = NOW + 301_000;
      assert.equal((await fetch(`${base}/api/liff/me`, { headers: h })).status, 200);
      assert.equal(calls.length, 2);
    },
    () => now,
  );
});

test('LINE verify 連不上 → 503（fail-closed，不放行）', async () => {
  await withApp(fakeLine([], { down: true }), async (base) => {
    const r = await fetch(`${base}/api/liff/me`, { headers: { authorization: `Bearer ${GOOD}` } });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, 'verify_unavailable');
  });
});

test('resolveLoginChannelId：env 優先，否則用 LIFF id 前綴，都沒有就丟錯', () => {
  assert.deepEqual(resolveLoginChannelId({ LINE_LOGIN_CHANNEL_ID: '123', LINE_LIFF_ID: '456-abc' }), { channelId: '123', source: 'env' });
  assert.deepEqual(resolveLoginChannelId({ LINE_LIFF_ID: '2010007178-xszHrky3' }), { channelId: '2010007178', source: 'liff_id_prefix' });
  assert.throws(() => resolveLoginChannelId({}));
  assert.throws(() => resolveLoginChannelId({ LINE_LIFF_ID: 'garbage' }));
});

test('靜態守門：liff 路由不再讀 x-line-user-id，且在所有路由前掛上 middleware', () => {
  const src = readFileSync(join(__dirname, '../src/routes/liff.ts'), 'utf8');
  assert.ok(!src.includes('x-line-user-id'), 'routes/liff.ts 不可再讀 x-line-user-id');
  // 路由改成 buildLiffRouter(auth) 建立（P1-2）：auth 必須是第一個 r.use，且正式匯出的 liffRouter 帶 createLiffAuth。
  // 執行期的層順序另由 liff-router-guard.test.ts 直接檢查 router stack。
  const useIdx = src.indexOf('r.use(auth)');
  const firstRoute = src.search(/\br\.(get|post|put|patch|delete)\(/);
  assert.ok(useIdx > 0 && firstRoute > useIdx, 'r.use(auth) 必須在第一個路由之前');
  assert.match(src, /export const liffRouter = buildLiffRouter\(\s*createLiffAuth\(/);
});
