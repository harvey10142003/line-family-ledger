// 關務署抓取的防護：只連 portal.sw.nat.gov.tw、不跟隨轉址、據實 User-Agent；拒絕存取另外標示；HTTP 錯誤／逾時／格式錯都當失敗（不丟例外）。
// 換掉 globalThis.fetch，不打網路、不碰 DB。
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchCustomsRates, CUSTOMS_HOST, CUSTOMS_JSON_URL } from '../src/services/fx';

const realFetch = globalThis.fetch;
const sample = readFileSync(join(__dirname, 'fixtures', 'customs-rates-sample.json'));
let seen: { url: string; init: any }[] = [];
const stub = (fn: (url: string) => Response | Promise<Response>) => {
  seen = [];
  globalThis.fetch = (async (u: any, init: any) => {
    seen.push({ url: String(u), init });
    return fn(String(u));
  }) as any;
};
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('抓當期 JSON：網址、不跟隨轉址、10 秒逾時、據實 User-Agent', async () => {
  stub(() => new Response(sample, { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
  const r = await fetchCustomsRates();
  assert.equal(r.kind, 'rates');
  if (r.kind === 'rates') assert.deepEqual(r.period, { start: '2026-11-11', end: '2026-11-20' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, CUSTOMS_JSON_URL);
  assert.equal(new URL(seen[0].url).hostname, 'portal.sw.nat.gov.tw');
  assert.equal(CUSTOMS_HOST, 'portal.sw.nat.gov.tw');
  assert.equal(seen[0].init.redirect, 'manual');
  assert.ok(seen[0].init.signal instanceof AbortSignal);
  assert.match(seen[0].init.headers['User-Agent'], /^family-ledger-fx\//); // 不偽裝瀏覽器
});

test('防機器人驗證頁（HTTP 200 的 HTML）、403、429 → refused（來源拒絕存取），只發一次請求', async () => {
  stub(() => new Response('<!DOCTYPE html><html><head><title>Challenge Validation</title></head><body><iframe id="sec-cpt-if"></iframe></body></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  const r = await fetchCustomsRates();
  assert.equal(r.kind, 'refused');
  assert.match((r as any).reason, /source refused access/);
  assert.equal(seen.length, 1);
  stub(() => new Response('forbidden', { status: 403 }));
  assert.equal((await fetchCustomsRates()).kind, 'refused');
  stub(() => new Response('too many', { status: 429 }));
  assert.equal((await fetchCustomsRates()).kind, 'refused');
});

test('轉址不跟、HTTP 錯誤、網路例外、格式異常 → error', async () => {
  stub(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x.json' } }));
  assert.equal((await fetchCustomsRates() as any).reason, 'redirect 302 (not followed)');
  assert.equal(seen.length, 1);
  stub(() => new Response('busy', { status: 503 }));
  assert.equal((await fetchCustomsRates() as any).reason, 'http 503');
  stub(() => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  });
  assert.equal((await fetchCustomsRates() as any).reason, 'timeout 10000ms');
  stub(() => new Response('{"start":"20261111","end":"20261120","items":[]}', { status: 200 }));
  assert.deepEqual(await fetchCustomsRates(), { kind: 'error', reason: 'no USD row' });
  stub(() => new Response('x'.repeat(300 * 1024), { status: 200 }));
  assert.match((await fetchCustomsRates() as any).reason, /body too large/);
});
