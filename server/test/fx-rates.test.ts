// 外幣參考匯率：解析關務署每旬報關匯率 JSON、旬別、拒絕存取判斷、用價、缺口、退回順序、換算捨入。純函式，不碰 DB／網路。
// 樣本檔 fixtures/customs-rates-sample.json：2026-11-07 從
//   https://portal.sw.nat.gov.tw/APGQ/GC331!downLoad?formBean.downLoadFile=CURRENT_JSON 下載的原檔（115 年 11 月中旬，29 幣含 TWD）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseCustomsJson,
  tenDayPeriodOf,
  tenDayPeriodLabel,
  isAccessRefused,
  pickSellRate,
  resolveFxQuote,
  convertToTwd,
  nearestRateDate,
  coveredThrough,
  countMissingBusinessDays,
  envFxRates,
  fxQuoteLabel,
  isWeekendYmd,
} from '../src/lib/fx-rates';
import { estimateTwd, referenceRates } from '../src/lib/amount-text';

const sample = readFileSync(join(__dirname, 'fixtures', 'customs-rates-sample.json'), 'utf8');
const LEDGER_CURRENCIES = ['USD', 'JPY', 'EUR', 'CNY', 'HKD', 'KRW', 'GBP', 'AUD', 'SGD', 'THB'];

test('解析關務署 JSON：期別、28 幣（TWD 不存）、記帳用到的 10 幣都有', () => {
  const r = parseCustomsJson(sample);
  assert.equal(r.kind, 'rates');
  if (r.kind !== 'rates') return;
  assert.deepEqual(r.period, { start: '2026-11-11', end: '2026-11-20' });
  assert.equal(r.rows.length, 28);
  assert.ok(!r.rows.some((x) => x.currency === 'TWD'));
  for (const c of LEDGER_CURRENCIES) assert.ok(r.rows.some((x) => x.currency === c), c);
  assert.deepEqual(r.rows.find((x) => x.currency === 'USD'), { currency: 'USD', buy: 32.83, sell: 32.93 });
  assert.deepEqual(r.rows.find((x) => x.currency === 'KRW'), { currency: 'KRW', buy: 0.02442, sell: 0.02449 });
  // BOM、CRLF 也吃
  assert.equal(parseCustomsJson('﻿' + sample.replace(/\r?\n/g, '\r\n')).kind, 'rates');
});

test('解析：格式異常一律 invalid（挑戰頁、空白、壞 JSON、期別不是一旬、沒 USD）', () => {
  const challenge = '<!DOCTYPE html><html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Your support ID is: 123</body></html>';
  assert.equal(parseCustomsJson(challenge).kind, 'invalid');
  assert.equal(parseCustomsJson('').kind, 'invalid');
  assert.equal(parseCustomsJson('{"start":"20261111"').kind, 'invalid');
  const base = (o: object) => JSON.stringify({ start: '20261111', end: '20261120', items: [{ code: 'USD', buyValue: '32.83', sellValue: '32.93' }], ...o });
  assert.equal(parseCustomsJson(base({})).kind, 'rates');
  assert.match((parseCustomsJson(base({ end: '20261121' })) as any).reason, /ten-day/); // 期別對不上
  assert.match((parseCustomsJson(base({ start: '20261112', end: '20261120' })) as any).reason, /ten-day/);
  assert.match((parseCustomsJson(base({ start: '2026-11-11' })) as any).reason, /bad period/);
  assert.match((parseCustomsJson(base({ start: '20260230', end: '20260228' })) as any).reason, /bad period/); // 不存在的日期
  assert.match((parseCustomsJson(base({ items: 'x' })) as any).reason, /no items/);
  assert.match((parseCustomsJson(base({ items: [{ code: 'JPY', buyValue: '0.2', sellValue: '0.21' }] })) as any).reason, /no USD/);
  // 單筆壞資料略過：非正數、代號怪、買價高於賣價、重複
  const r = parseCustomsJson(
    base({
      items: [
        { code: 'USD', buyValue: '32.83', sellValue: '32.93' },
        { code: 'USD', buyValue: '1', sellValue: '2' },
        { code: 'JPY', buyValue: '0', sellValue: '-1' },
        { code: 'eur', buyValue: '36.77', sellValue: '36.0' },
        { code: 'X1Y', buyValue: '1', sellValue: '1' },
        { code: 'gbp', buyValue: '44.1', sellValue: '44.5' },
      ],
    }),
  );
  assert.equal(r.kind, 'rates');
  if (r.kind === 'rates') assert.deepEqual(r.rows.map((x) => [x.currency, x.sell]), [['USD', 32.93], ['GBP', 44.5]]);
});

test('旬別：上旬 1–10、中旬 11–20、下旬 21–月底（含閏年 2 月）', () => {
  assert.deepEqual(tenDayPeriodOf('2026-11-07'), { start: '2026-11-01', end: '2026-11-10' });
  assert.deepEqual(tenDayPeriodOf('2026-11-11'), { start: '2026-11-11', end: '2026-11-20' });
  assert.deepEqual(tenDayPeriodOf('2026-11-30'), { start: '2026-11-21', end: '2026-11-30' });
  assert.deepEqual(tenDayPeriodOf('2026-12-31'), { start: '2026-12-21', end: '2026-12-31' });
  assert.deepEqual(tenDayPeriodOf('2028-02-25'), { start: '2028-02-21', end: '2028-02-29' });
  assert.deepEqual(tenDayPeriodOf('2026-02-21'), { start: '2026-02-21', end: '2026-02-28' });
  assert.equal(tenDayPeriodLabel('2026-11-01'), '11月上旬');
  assert.equal(tenDayPeriodLabel('2026-11-11'), '11月中旬');
  assert.equal(tenDayPeriodLabel('2026-01-21'), '1月下旬');
  // 下旬月底 28 號的 JSON 也要過
  assert.equal(parseCustomsJson(JSON.stringify({ start: '20260221', end: '20260228', items: [{ code: 'USD', buyValue: '32', sellValue: '32.1' }] })).kind, 'rates');
});

test('來源拒絕存取：403／429／401、HTML 驗證頁；正常 JSON、一般 5xx 不算', () => {
  assert.equal(isAccessRefused(403, 'text/html', ''), true);
  assert.equal(isAccessRefused(429, null, 'slow down'), true);
  assert.equal(isAccessRefused(401, null, ''), true);
  assert.equal(isAccessRefused(200, 'text/html', '<html><head><title>Challenge Validation</title></head><iframe id="sec-cpt-if"></iframe></html>'), true);
  assert.equal(isAccessRefused(200, 'application/octet-stream', '<!DOCTYPE html><html>Request Rejected. Your support ID is: 1</html>'), true);
  assert.equal(isAccessRefused(200, 'application/octet-stream', sample), false);
  assert.equal(isAccessRefused(503, 'text/html', '<html>Service Unavailable</html>'), false);
  assert.equal(isAccessRefused(200, 'text/html', '<html><body>維護中</body></html>'), false); // 一般 HTML 錯誤頁 → 解析失敗，不是拒絕
});

test('用價：關務署用賣出價；臺銀舊資料即期賣出優先、沒有才用現金賣出', () => {
  assert.deepEqual(resolveFxQuote('USD', { rateDate: '2026-11-11', spotSell: 32.93, cashSell: null, source: 'CUSTOMS' }, {} as NodeJS.ProcessEnv), {
    currency: 'USD',
    rate: 32.93,
    basis: 'CUSTOMS_SELL',
    rateDate: '2026-11-11',
  });
  assert.deepEqual(pickSellRate({ spotSell: 32.95, cashSell: 33.145 }), { rate: 32.95, basis: 'BOT_SPOT_SELL' });
  assert.deepEqual(pickSellRate({ spotSell: null, cashSell: 0.00218 }), { rate: 0.00218, basis: 'BOT_CASH_SELL' });
  assert.equal(pickSellRate({ spotSell: null, cashSell: null }), null);
  // 關務署那筆沒有賣價（不會發生，防呆）→ 不拿 cashSell，退 env
  assert.equal(resolveFxQuote('USD', { rateDate: '2026-11-11', spotSell: null, cashSell: 30, source: 'CUSTOMS' }, { FX_REFERENCE_RATES: '{"USD":31.9}' } as NodeJS.ProcessEnv)!.basis, 'ENV');
});

test('最近一筆：消費日當天或之前最近一筆；超過 30 天不用', () => {
  const dates = ['2026-10-21', '2026-11-01', '2026-11-11'];
  assert.equal(nearestRateDate(dates, '2026-11-07'), '2026-11-01'); // 上旬
  assert.equal(nearestRateDate(dates, '2026-11-15'), '2026-11-11'); // 中旬
  assert.equal(nearestRateDate(dates, '2026-10-20'), null); // 比最早的還早
  assert.equal(nearestRateDate(dates, '2026-12-31'), null); // 回看超過 30 天
  assert.equal(nearestRateDate(['2026-11-04'], '2026-12-04'), '2026-11-04'); // 剛好 30 天
});

test('缺口：關務署那筆涵蓋到旬底；之後只數平日；臺銀舊資料只涵蓋當天', () => {
  assert.equal(coveredThrough({ rateDate: '2026-11-11', source: 'CUSTOMS' }), '2026-11-20');
  assert.equal(coveredThrough({ rateDate: '2026-11-21', source: 'CUSTOMS' }), '2026-11-30');
  assert.equal(coveredThrough({ rateDate: '2026-10-23', source: 'BOT' }), '2026-10-23');
  assert.equal(coveredThrough(null), null);
  // 下一旬已公布（涵蓋日在未來）→ 0
  assert.equal(countMissingBusinessDays('2026-11-20', '2026-11-07'), 0);
  // 涵蓋到 11-10（二），今天 11-16（一）：11-11～13、11-16 → 4（週末不算）
  assert.equal(countMissingBusinessDays('2026-11-10', '2026-11-16'), 4);
  // 正式機現況：臺銀最後一筆 10-23（五），11-06（五）→ 10 個平日（假日不另外扣）
  assert.equal(countMissingBusinessDays('2026-10-23', '2026-11-06'), 10);
  // 週末不算缺
  assert.equal(countMissingBusinessDays('2026-11-06', '2026-11-08'), 0);
  // 完全沒資料 → 數滿 30 天內的平日
  assert.equal(countMissingBusinessDays(null, '2026-11-06'), 22);
  assert.equal(isWeekendYmd('2026-11-01'), true);
  assert.equal(isWeekendYmd('2026-11-02'), false);
});

test('退回順序：DB → env FX_REFERENCE_RATES → 固定值 → null', () => {
  const env = { FX_REFERENCE_RATES: '{"USD":31.9,"chf":36.1}' } as NodeJS.ProcessEnv;
  // 舊資料沒給 source 當臺銀
  assert.deepEqual(resolveFxQuote('USD', { rateDate: '2026-11-04', spotSell: 32.875, cashSell: 33.095 }, env), {
    currency: 'USD',
    rate: 32.875,
    basis: 'BOT_SPOT_SELL',
    rateDate: '2026-11-04',
  });
  assert.equal(resolveFxQuote('USD', { rateDate: '2026-11-04', spotSell: null, cashSell: null, source: 'BOT' }, env)!.basis, 'ENV');
  assert.deepEqual(resolveFxQuote('usd', null, env), { currency: 'USD', rate: 31.9, basis: 'ENV', rateDate: null });
  assert.equal(resolveFxQuote('CHF', null, env)!.rate, 36.1); // env 鍵不分大小寫
  assert.deepEqual(resolveFxQuote('JPY', null, env), { currency: 'JPY', rate: 0.21, basis: 'DEFAULT', rateDate: null });
  assert.equal(resolveFxQuote('ZAR', null, {} as NodeJS.ProcessEnv), null); // 沒有固定值
  assert.deepEqual(envFxRates({ FX_REFERENCE_RATES: 'not json' } as NodeJS.ProcessEnv), {});
  assert.deepEqual(envFxRates({ FX_REFERENCE_RATES: '{"USD":-1,"JPY":"0.2"}' } as NodeJS.ProcessEnv), {});
});

test('換算捨入：四捨五入到元，.5 進位不被浮點吃掉', () => {
  assert.equal(convertToTwd(15.99, 32.5), 520); // 519.675
  assert.equal(convertToTwd(15.99, 32.93), 527); // 526.5507
  assert.equal(convertToTwd(100, 1.005), 101); // 100.5 → 101（浮點 100*1.005=100.49999…，Math.round 會給 100）
  assert.equal(convertToTwd(3, 0.5), 2); // 1.5 → 2
  assert.equal(convertToTwd(1_000_000, 0.00218), 2180);
  assert.equal(convertToTwd(0.01, 0.21), 0);
  assert.equal(Math.round(100 * 1.005), 100); // 證明直接用浮點 Math.round 會錯
  assert.equal(estimateTwd(100, 'JPY', { JPY: 1.005 }), 101);
  assert.equal(referenceRates({ FX_REFERENCE_RATES: '{"USD":31}' } as NodeJS.ProcessEnv).USD, 31);
});

test('匯率說明文字', () => {
  assert.equal(fxQuoteLabel({ rate: 32.93, basis: 'CUSTOMS_SELL', rateDate: '2026-11-11' }), '關務署 11月中旬報關匯率 32.93');
  assert.equal(fxQuoteLabel({ rate: 32.875, basis: 'BOT_SPOT_SELL', rateDate: '2026-11-04' }), '臺銀 11/04 即期賣出 32.875');
  assert.equal(fxQuoteLabel({ rate: 0.00218, basis: 'BOT_CASH_SELL', rateDate: '2026-11-04' }), '臺銀 11/04 現金賣出 0.00218');
  assert.equal(fxQuoteLabel({ rate: 32.5, basis: 'DEFAULT', rateDate: null }), '參考匯率 32.5');
});
