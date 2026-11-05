// 臺銀牌告：存表、補抓、查無資料／失敗處理、消費日最近一筆、退回順序、計畫覆寫。走真的 PostgreSQL，不打臺銀（fetcher 換假的）。
//
//   LEDGER_TEST_DATABASE_URL=postgresql://user@127.0.0.1:5432/ledger_test npm --workspace server test
// 沒設就整支跳過。只接受 127.0.0.1／localhost。
// FxRateDaily 是全站共用表：這支只用 2020 年的日期，其他測試（2026）的消費日回看 30 天碰不到；跑完刪掉。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DB_URL = process.env.LEDGER_TEST_DATABASE_URL ?? '';
const SKIP = !DB_URL ? 'LEDGER_TEST_DATABASE_URL 未設（需要本機拋棄式 PostgreSQL）' : false;
if (DB_URL && !/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(DB_URL)) {
  throw new Error('LEDGER_TEST_DATABASE_URL 只能指向 127.0.0.1／localhost 的測試庫');
}

let prisma: any;
let fx: typeof import('../src/services/fx');
let parseBotCsv: typeof import('../src/lib/fx-rates').parseBotCsv;
const sample = readFileSync(join(__dirname, 'fixtures', 'bot-rates-sample.csv'), 'utf8');
const ENV = { FX_REFERENCE_RATES: '{"USD":31.9}' } as NodeJS.ProcessEnv;
const range = { gte: new Date('2019-12-01T00:00:00Z'), lte: new Date('2020-02-28T00:00:00Z') };

before(async () => {
  if (SKIP) return;
  process.env.DATABASE_URL = DB_URL;
  ({ prisma } = await import('../src/prisma'));
  fx = await import('../src/services/fx');
  ({ parseBotCsv } = await import('../src/lib/fx-rates'));
  await prisma.fxRateDaily.deleteMany({ where: { rateDate: range } });
  fx.resetFxStatusForTest();
});

after(async () => {
  if (SKIP) return;
  await prisma.fxRateDaily.deleteMany({ where: { rateDate: range } });
  await prisma.$disconnect();
});

const sampleRows = () => {
  const r = parseBotCsv(sample);
  if (r.kind !== 'rates') throw new Error('sample');
  return r.rows;
};
// 每天的 USD 即期賣出不同，才分得出用了哪一天
const rowsFor = (usdSpotSell: number) => sampleRows().map((r) => (r.currency === 'USD' ? { ...r, spotSell: usdSpotSell } : r));

const calls: string[] = [];
const fakeFetcher = async (ymd: string): Promise<any> => {
  calls.push(ymd);
  if (ymd === '2020-01-06') return { kind: 'rates', rows: rowsFor(30.06) };
  if (ymd === '2020-01-07') return { kind: 'no_data' }; // 當作國定假日
  if (ymd === '2020-01-08') return { kind: 'error', reason: 'bot challenge page (not CSV)' };
  if (ymd === '2020-01-09') return { kind: 'rates', rows: rowsFor(30.09) };
  if (ymd === '2020-01-10') return { kind: 'rates', rows: rowsFor(30.1) };
  return { kind: 'error', reason: 'timeout 10000ms' };
};

test('補抓：平日才抓、存每幣一列、查無資料記住、失敗只記下來', { skip: SKIP }, async () => {
  // 2020-01-10（五）17:00 台北
  const r = await fx.syncFxRates({ now: new Date('2020-01-10T09:00:00Z'), days: 7, fetcher: fakeFetcher, gapMs: 0 });
  assert.deepEqual(calls, ['2020-01-06', '2020-01-07', '2020-01-08', '2020-01-09', '2020-01-10']); // 01-04、01-05 週末不抓
  assert.deepEqual(r.saved.map((x) => x.date), ['2020-01-06', '2020-01-09', '2020-01-10']);
  assert.equal(r.saved[0].currencies, 7);
  assert.deepEqual(r.noData, ['2020-01-07']);
  assert.deepEqual(r.failed, [{ date: '2020-01-08', reason: 'bot challenge page (not CSV)' }]);
  const n = await prisma.fxRateDaily.count({ where: { rateDate: range } });
  assert.equal(n, 21);
  const idr = await prisma.fxRateDaily.findFirst({ where: { currency: 'IDR', rateDate: new Date('2020-01-06T00:00:00Z') } });
  assert.equal(idr.spotSell, null);
  assert.equal(Number(idr.cashSell), 0.00218);
  const h = fx.fxHealth();
  assert.equal(h.latestRateDate, '2020-01-10');
  assert.equal(h.missingBusinessDays, 0);
  assert.match(h.lastError ?? '', /2020-01-08/);

  // 再跑一次：只重抓失敗的那天（存過的、查無資料的都跳過）；同一天重抓是覆寫不是新增
  calls.length = 0;
  await fx.syncFxRates({ now: new Date('2020-01-10T09:30:00Z'), days: 7, fetcher: fakeFetcher, gapMs: 0 });
  assert.deepEqual(calls, ['2020-01-08']);
  await fx.saveRates('2020-01-10', rowsFor(30.1));
  assert.equal(await prisma.fxRateDaily.count({ where: { rateDate: range } }), 21);
});

test('消費日換算：當天、週末用週五、假日用前一個營業日、超過 30 天或更早退回 env／固定值', { skip: SKIP }, async () => {
  assert.deepEqual(await fx.quoteFx('USD', '2020-01-10', ENV), { currency: 'USD', rate: 30.1, basis: 'BOT_SPOT_SELL', rateDate: '2020-01-10' });
  assert.equal((await fx.quoteFx('USD', '2020-01-12', ENV))!.rateDate, '2020-01-10'); // 週日 → 週五
  assert.equal((await fx.quoteFx('USD', '2020-01-07', ENV))!.rateDate, '2020-01-06'); // 假日 → 前一個營業日
  assert.equal((await fx.quoteFx('USD', '2020-01-08', ENV))!.rate, 30.06); // 抓失敗那天 → 最近一筆
  const idr = await fx.quoteFx('IDR', '2020-01-10', ENV);
  assert.deepEqual(idr, { currency: 'IDR', rate: 0.00218, basis: 'BOT_CASH_SELL', rateDate: '2020-01-10' }); // 沒即期 → 現金賣出
  assert.deepEqual(await fx.quoteFx('USD', '2020-02-20', ENV), { currency: 'USD', rate: 31.9, basis: 'ENV', rateDate: null }); // 超過 30 天
  assert.deepEqual(await fx.quoteFx('USD', '2020-01-03', ENV), { currency: 'USD', rate: 31.9, basis: 'ENV', rateDate: null }); // 比第一筆早
  assert.deepEqual(await fx.quoteFx('JPY', '2020-01-03', {} as NodeJS.ProcessEnv), { currency: 'JPY', rate: 0.21, basis: 'DEFAULT', rateDate: null });
  assert.equal(await fx.quoteFx('ZAR', '2020-01-03', {} as NodeJS.ProcessEnv), null);
  assert.equal((await fx.quoteFx('ZAR', '2020-01-10', {} as NodeJS.ProcessEnv))!.rate, 2.049); // 臺銀有、固定值沒有的幣也能換
});

test('計畫覆寫：外幣收支依消費日改成臺銀匯率，台幣收支不動', { skip: SKIP }, async () => {
  const date = (ymd: string) => ({ ymd, ok: true, explicit: true, raw: ymd });
  const plan: any = {
    issues: [],
    items: [
      { type: 'TX', txType: 'EXPENSE', amount: 520, originalCurrency: 'USD', originalAmount: 15.99, amountEstimated: true, categoryName: 'x', note: '', date: date('2020-01-11'), accountText: null, ownerMemberId: null, bookTo: 'FAMILY', segment: '' },
      { type: 'TX', txType: 'EXPENSE', amount: 120, originalCurrency: null, originalAmount: null, amountEstimated: false, categoryName: 'x', note: '', date: date('2020-01-11'), accountText: null, ownerMemberId: null, bookTo: 'FAMILY', segment: '' },
      { type: 'TX', txType: 'EXPENSE', amount: 519, originalCurrency: 'USD', originalAmount: 15.99, amountEstimated: true, categoryName: 'x', note: '', date: date('2019-12-15'), accountText: null, ownerMemberId: null, bookTo: 'FAMILY', segment: '' },
    ],
  };
  await fx.applyFxToPlan(plan, ENV);
  assert.equal(plan.items[0].amount, 481); // 15.99 × 30.1 = 481.299
  assert.deepEqual(plan.items[0].fx, { rate: 30.1, basis: 'BOT_SPOT_SELL', rateDate: '2020-01-10' });
  assert.equal(plan.items[1].amount, 120);
  assert.equal(plan.items[1].fx, undefined);
  assert.equal(plan.items[2].amount, 510); // 15.99 × 31.9（env）= 510.081
  assert.equal(plan.items[2].fx.basis, 'ENV');
});

test('連續抓不到：缺 2 個營業日以上 → /health 看得到，不丟錯', { skip: SKIP }, async () => {
  // 2020-01-15（三）17:00：01-13、01-14、01-15 都失敗
  const r = await fx.syncFxRates({ now: new Date('2020-01-15T09:00:00Z'), days: 7, fetcher: async () => ({ kind: 'error', reason: 'timeout 10000ms' }), gapMs: 0 });
  assert.deepEqual(r.failed.map((x) => x.date), ['2020-01-13', '2020-01-14', '2020-01-15']); // 只補最近 7 天，01-08 已超出
  const h = fx.fxHealth();
  assert.equal(h.latestRateDate, '2020-01-10');
  assert.equal(h.missingBusinessDays, 3);
  assert.match(h.lastError ?? '', /timeout/);
  // 記帳照樣能換（用 01-10 那筆）
  assert.equal((await fx.quoteFx('USD', '2020-01-15', ENV))!.rateDate, '2020-01-10');
});
