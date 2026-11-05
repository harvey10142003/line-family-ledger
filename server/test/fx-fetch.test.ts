// 臺銀抓取的防護：只連 rate.bot.com.tw、不跟隨轉址、挑戰頁／HTTP 錯誤／逾時都當失敗（回 error，不丟例外）。
// 換掉 globalThis.fetch，不打網路、不碰 DB。
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchBotRates, BOT_HOST } from '../src/services/fx';

const realFetch = globalThis.fetch;
const sample = readFileSync(join(__dirname, 'fixtures', 'bot-rates-sample.csv'));
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

test('抓指定日的 CSV：網址、不跟隨轉址、10 秒逾時', async () => {
  stub(() => new Response(sample, { status: 200, headers: { 'content-type': 'text/csv' } }));
  const r = await fetchBotRates('2026-11-04');
  assert.equal(r.kind, 'rates');
  assert.equal(seen[0].url, `https://${BOT_HOST}/xrt/flcsv/0/2026-11-04`);
  assert.equal(new URL(seen[0].url).hostname, 'rate.bot.com.tw');
  assert.equal(seen[0].init.redirect, 'manual');
  assert.ok(seen[0].init.signal instanceof AbortSignal);
});

test('假日查無資料 → no_data', async () => {
  stub(() => new Response('很抱歉，本次查詢找不到任何一筆資料！', { status: 200 }));
  assert.deepEqual(await fetchBotRates('2026-11-01'), { kind: 'no_data' });
});

test('防機器人挑戰頁（HTTP 200 的 HTML）→ error', async () => {
  stub(() => new Response('<!DOCTYPE html><html><head><title>Challenge Validation</title></head><body><iframe id="sec-cpt-if"></iframe></body></html>', { status: 200 }));
  assert.deepEqual(await fetchBotRates('2026-11-04'), { kind: 'error', reason: 'bot challenge page (not CSV)' });
});

test('轉址不跟、HTTP 錯誤、網路例外、日期格式錯 → error', async () => {
  stub(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x.csv' } }));
  assert.equal((await fetchBotRates('2026-11-04') as any).reason, 'redirect 302 (not followed)');
  assert.equal(seen.length, 1);
  stub(() => new Response('busy', { status: 503 }));
  assert.equal((await fetchBotRates('2026-11-04') as any).reason, 'http 503');
  stub(() => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  });
  assert.equal((await fetchBotRates('2026-11-04') as any).reason, 'timeout 10000ms');
  stub(() => new Response(sample));
  assert.equal((await fetchBotRates('../../evil') as any).kind, 'error');
  assert.equal(seen.length, 0, '日期不合法就不發請求');
});
