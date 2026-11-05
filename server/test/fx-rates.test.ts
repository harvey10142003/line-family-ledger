// 外幣參考匯率（臺銀牌告）：解析 CSV、挑用價、最近營業日、退回順序、換算捨入。純函式，不碰 DB／網路。
// 樣本檔 fixtures/bot-rates-sample.csv：臺銀 https://rate.bot.com.tw/xrt/flcsv/0/day 的格式（UTF-8 BOM、22 欄、列尾逗號），
// 即期／現金數字取自 2026-11-05 實際牌告的 7 個幣別，遠期欄位填 0。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseBotCsv,
  pickSellRate,
  resolveFxQuote,
  convertToTwd,
  nearestRateDate,
  datesToBackfill,
  envFxRates,
  fxQuoteLabel,
  isWeekendYmd,
} from '../src/lib/fx-rates';
import { estimateTwd, referenceRates } from '../src/lib/amount-text';

const sample = readFileSync(join(__dirname, 'fixtures', 'bot-rates-sample.csv'), 'utf8');

test('解析臺銀 CSV：BOM、列尾逗號、0＝沒報價', () => {
  const r = parseBotCsv(sample);
  assert.equal(r.kind, 'rates');
  if (r.kind !== 'rates') return;
  assert.deepEqual(r.rows.map((x) => x.currency), ['USD', 'HKD', 'GBP', 'AUD', 'ZAR', 'SEK', 'IDR']);
  const usd = r.rows[0];
  assert.deepEqual(usd, { currency: 'USD', cashBuy: 32.475, spotBuy: 32.8, cashSell: 33.145, spotSell: 32.95 });
  const zar = r.rows.find((x) => x.currency === 'ZAR')!;
  assert.equal(zar.cashSell, null);
  assert.equal(zar.spotSell, 2.049);
  const idr = r.rows.find((x) => x.currency === 'IDR')!;
  assert.equal(idr.spotSell, null);
  assert.equal(idr.cashSell, 0.00218);
});

test('解析：假日查無資料 → no_data；防機器人挑戰頁、空白、改版 → invalid', () => {
  assert.deepEqual(parseBotCsv('很抱歉，本次查詢找不到任何一筆資料！'), { kind: 'no_data' });
  const challenge = '<!DOCTYPE html><html lang="en"><head><title>Challenge Validation</title></head><body></body></html>';
  assert.equal(parseBotCsv(challenge).kind, 'invalid');
  assert.equal(parseBotCsv('').kind, 'invalid');
  assert.equal(parseBotCsv('Currency,Rate,Cash,Spot\nUSD,Buy,32,32').kind, 'invalid');
  // 只有表頭沒有資料列
  assert.equal(parseBotCsv(sample.split(/\r?\n/)[0]).kind, 'invalid');
});

test('用價：即期賣出優先，沒有即期才用現金賣出', () => {
  assert.deepEqual(pickSellRate({ spotSell: 32.95, cashSell: 33.145 }), { rate: 32.95, basis: 'BOT_SPOT_SELL' });
  assert.deepEqual(pickSellRate({ spotSell: null, cashSell: 0.00218 }), { rate: 0.00218, basis: 'BOT_CASH_SELL' });
  assert.equal(pickSellRate({ spotSell: null, cashSell: null }), null);
});

test('最近營業日：消費日當天或之前最近一筆；週末用週五；超過 30 天不用', () => {
  const dates = ['2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04'];
  assert.equal(nearestRateDate(dates, '2026-11-04'), '2026-11-04'); // 當天
  assert.equal(nearestRateDate(dates, '2026-11-05'), '2026-11-04'); // 當天還沒收盤 → 前一個營業日
  assert.equal(nearestRateDate(dates, '2026-11-01'), '2026-10-30'); // 週日 → 週五
  assert.equal(nearestRateDate(dates, '2026-10-29'), null); // 比最早的還早
  assert.equal(nearestRateDate(dates, '2026-12-31'), null); // 回看超過 30 天
  assert.equal(nearestRateDate(['2026-11-04'], '2026-12-04'), '2026-11-04'); // 剛好 30 天
});

test('補抓清單：只抓平日、已存的跳過、今天要過 16:30', () => {
  const have = new Set(['2026-11-03']);
  // 2026-11-05（四）15:00：今天還沒收盤 → 不抓今天
  assert.deepEqual(datesToBackfill(have, '2026-11-05', 15 * 60, 7), ['2026-10-30', '2026-11-02', '2026-11-04']);
  // 16:30 之後 → 加今天
  assert.deepEqual(datesToBackfill(have, '2026-11-05', 16 * 60 + 30, 7), ['2026-10-30', '2026-11-02', '2026-11-04', '2026-11-05']);
  assert.equal(isWeekendYmd('2026-11-01'), true);
  assert.equal(isWeekendYmd('2026-11-02'), false);
});

test('退回順序：臺銀 → env FX_REFERENCE_RATES → 固定值 → null', () => {
  const env = { FX_REFERENCE_RATES: '{"USD":31.9,"chf":36.1}' } as NodeJS.ProcessEnv;
  assert.deepEqual(resolveFxQuote('USD', { rateDate: '2026-11-04', spotSell: 32.875, cashSell: 33.095 }, env), {
    currency: 'USD',
    rate: 32.875,
    basis: 'BOT_SPOT_SELL',
    rateDate: '2026-11-04',
  });
  // 臺銀那筆沒有即期也沒有現金 → env
  assert.equal(resolveFxQuote('USD', { rateDate: '2026-11-04', spotSell: null, cashSell: null }, env)!.basis, 'ENV');
  assert.deepEqual(resolveFxQuote('usd', null, env), { currency: 'USD', rate: 31.9, basis: 'ENV', rateDate: null });
  assert.equal(resolveFxQuote('CHF', null, env)!.rate, 36.1); // env 鍵不分大小寫
  assert.deepEqual(resolveFxQuote('JPY', null, env), { currency: 'JPY', rate: 0.21, basis: 'DEFAULT', rateDate: null });
  assert.equal(resolveFxQuote('ZAR', null, {} as NodeJS.ProcessEnv), null); // 沒有固定值
  // env 格式錯 → 當沒設
  assert.deepEqual(envFxRates({ FX_REFERENCE_RATES: 'not json' } as NodeJS.ProcessEnv), {});
  assert.deepEqual(envFxRates({ FX_REFERENCE_RATES: '{"USD":-1,"JPY":"0.2"}' } as NodeJS.ProcessEnv), {});
});

test('換算捨入：四捨五入到元，.5 進位不被浮點吃掉', () => {
  assert.equal(convertToTwd(15.99, 32.5), 520); // 519.675
  assert.equal(convertToTwd(15.99, 32.875), 526); // 525.67125
  assert.equal(convertToTwd(100, 1.005), 101); // 100.5 → 101（浮點 100*1.005=100.49999…，Math.round 會給 100）
  assert.equal(convertToTwd(3, 0.5), 2); // 1.5 → 2
  assert.equal(convertToTwd(1_000_000, 0.00218), 2180);
  assert.equal(convertToTwd(0.01, 0.21), 0);
  assert.equal(Math.round(100 * 1.005), 100); // 證明直接用浮點 Math.round 會錯
  // 舊的同步估算也改用同一個捨入
  assert.equal(estimateTwd(100, 'JPY', { JPY: 1.005 }), 101);
  assert.equal(referenceRates({ FX_REFERENCE_RATES: '{"USD":31}' } as NodeJS.ProcessEnv).USD, 31);
});

test('匯率說明文字', () => {
  assert.equal(fxQuoteLabel({ rate: 32.875, basis: 'BOT_SPOT_SELL', rateDate: '2026-11-04' }), '臺銀 11/04 即期賣出 32.875');
  assert.equal(fxQuoteLabel({ rate: 0.00218, basis: 'BOT_CASH_SELL', rateDate: '2026-11-04' }), '臺銀 11/04 現金賣出 0.00218');
  assert.equal(fxQuoteLabel({ rate: 32.5, basis: 'DEFAULT', rateDate: null }), '參考匯率 32.5');
});
