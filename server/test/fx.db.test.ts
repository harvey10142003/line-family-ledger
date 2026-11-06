// 關務署每旬報關匯率：存表、旬內換算、跨旬、假日、缺期退回、拒絕存取冷卻、/health 缺口、計畫覆寫。
// 走真的 PostgreSQL，不打關務署（fetcher 換假的）。
//
//   LEDGER_TEST_DATABASE_URL=postgresql://user@127.0.0.1:5432/ledger_test npm --workspace server test
// 沒設就整支跳過。只接受 127.0.0.1／localhost。
// FxRateDaily 是全站共用表：這支只用 2020 年的日期，其他測試（2026）的消費日回看 30 天碰不到；跑完刪掉。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const DB_URL = process.env.LEDGER_TEST_DATABASE_URL ?? '';
const SKIP = !DB_URL ? 'LEDGER_TEST_DATABASE_URL 未設（需要本機拋棄式 PostgreSQL）' : false;
if (DB_URL && !/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(DB_URL)) {
  throw new Error('LEDGER_TEST_DATABASE_URL 只能指向 127.0.0.1／localhost 的測試庫');
}

let prisma: any;
let fx: typeof import('../src/services/fx');
const ENV = { FX_REFERENCE_RATES: '{"USD":31.9}' } as NodeJS.ProcessEnv;
const range = { gte: new Date('2019-12-01T00:00:00Z'), lte: new Date('2020-03-31T00:00:00Z') };

before(async () => {
  if (SKIP) return;
  process.env.DATABASE_URL = DB_URL;
  ({ prisma } = await import('../src/prisma'));
  fx = await import('../src/services/fx');
  await prisma.fxRateDaily.deleteMany({ where: { rateDate: range } });
  fx.resetFxStatusForTest();
});

after(async () => {
  if (SKIP) return;
  await prisma.fxRateDaily.deleteMany({ where: { rateDate: range } });
  await prisma.$disconnect();
});

const period = (start: string, end: string, usdSell: number) => ({
  kind: 'rates' as const,
  period: { start, end },
  rows: [
    { currency: 'USD', buy: usdSell - 0.1, sell: usdSell },
    { currency: 'JPY', buy: 0.2059, sell: 0.2099 },
    { currency: 'ZAR', buy: 1.968, sell: 2.048 },
  ],
});
// 2020-01-11（六）01:00 台北 = 2020-01-10T17:00Z
const at = (iso: string) => new Date(iso);

test('存一旬：每幣一列、rateDate＝旬首、source=CUSTOMS；同旬重抓是覆寫', { skip: SKIP }, async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return period('2020-01-01', '2020-01-10', 30.05);
  };
  const r = await fx.syncFxRates({ now: at('2020-01-06T09:00:00Z'), fetcher });
  assert.equal(calls, 1);
  assert.deepEqual(r.saved, { periodStart: '2020-01-01', periodEnd: '2020-01-10', currencies: 3 });
  assert.equal(r.failed, null);
  await fx.syncFxRates({ now: at('2020-01-07T09:00:00Z'), fetcher });
  assert.equal(await prisma.fxRateDaily.count({ where: { rateDate: range } }), 3);
  const usd = await prisma.fxRateDaily.findFirst({ where: { currency: 'USD', rateDate: new Date('2020-01-01T00:00:00Z') } });
  assert.equal(usd.source, 'CUSTOMS');
  assert.equal(Number(usd.spotSell), 30.05);
  assert.equal(usd.cashSell, null);
  const h = fx.fxHealth();
  assert.equal(h.source, 'CUSTOMS');
  assert.equal(h.latestRateDate, '2020-01-01');
  assert.equal(h.coveredThrough, '2020-01-10');
  assert.equal(h.missingBusinessDays, 0);

  // 下一旬在當旬內先公布（01-08 抓到 01-11～01-20）
  await fx.syncFxRates({ now: at('2020-01-08T09:00:00Z'), fetcher: async () => period('2020-01-11', '2020-01-20', 30.15) });
  assert.equal(fx.fxHealth().coveredThrough, '2020-01-20');
});

test('消費日換算：旬內同一個數字、跨旬換、週末假日照旬算、超過 30 天退回 env／固定值', { skip: SKIP }, async () => {
  assert.deepEqual(await fx.quoteFx('USD', '2020-01-01', ENV), { currency: 'USD', rate: 30.05, basis: 'CUSTOMS_SELL', rateDate: '2020-01-01' }); // 元旦（假日）
  assert.equal((await fx.quoteFx('USD', '2020-01-05', ENV))!.rate, 30.05); // 週日
  assert.equal((await fx.quoteFx('USD', '2020-01-10', ENV))!.rate, 30.05); // 旬底
  assert.deepEqual(await fx.quoteFx('USD', '2020-01-11', ENV), { currency: 'USD', rate: 30.15, basis: 'CUSTOMS_SELL', rateDate: '2020-01-11' }); // 下一旬
  assert.equal((await fx.quoteFx('ZAR', '2020-01-15', {} as NodeJS.ProcessEnv))!.rate, 2.048); // 固定值沒有的幣也能換
  // 中旬之後沒資料：01-25 仍用 01-11 那筆（30 天內）
  assert.equal((await fx.quoteFx('USD', '2020-01-25', ENV))!.rateDate, '2020-01-11');
  // 超過 30 天 → env／固定值
  assert.deepEqual(await fx.quoteFx('USD', '2020-02-20', ENV), { currency: 'USD', rate: 31.9, basis: 'ENV', rateDate: null });
  assert.deepEqual(await fx.quoteFx('JPY', '2020-02-20', {} as NodeJS.ProcessEnv), { currency: 'JPY', rate: 0.21, basis: 'DEFAULT', rateDate: null });
  assert.equal(await fx.quoteFx('ZAR', '2020-02-20', {} as NodeJS.ProcessEnv), null);
});

test('之前沒資料（剛上線缺上一旬）→ 用 11 天內已公布的下一旬；再遠就退回', { skip: SKIP }, async () => {
  // 2019-12-25：之前沒有任何資料，下一筆 2020-01-01（7 天後）
  assert.deepEqual(await fx.quoteFx('USD', '2019-12-25', ENV), { currency: 'USD', rate: 30.05, basis: 'CUSTOMS_SELL', rateDate: '2020-01-01' });
  // 2019-12-15：下一筆在 17 天後 → env
  assert.equal((await fx.quoteFx('USD', '2019-12-15', ENV))!.basis, 'ENV');
});

test('臺銀舊資料（source=BOT）照舊可用，口徑標臺銀', { skip: SKIP }, async () => {
  await prisma.fxRateDaily.create({ data: { currency: 'USD', rateDate: new Date('2020-02-03T00:00:00Z'), spotSell: 30.5, cashSell: 30.8, source: 'BOT' } });
  assert.deepEqual(await fx.quoteFx('USD', '2020-02-04', ENV), { currency: 'USD', rate: 30.5, basis: 'BOT_SPOT_SELL', rateDate: '2020-02-03' });
});

test('計畫覆寫：外幣收支依消費日改成關務署匯率，台幣收支不動', { skip: SKIP }, async () => {
  const date = (ymd: string) => ({ ymd, ok: true, explicit: true, raw: ymd });
  const plan: any = {
    issues: [],
    items: [
      { type: 'TX', txType: 'EXPENSE', amount: 520, originalCurrency: 'USD', originalAmount: 15.99, amountEstimated: true, categoryName: 'x', note: '', date: date('2020-01-12'), accountText: null, ownerMemberId: null, bookTo: 'FAMILY', segment: '' },
      { type: 'TX', txType: 'EXPENSE', amount: 120, originalCurrency: null, originalAmount: null, amountEstimated: false, categoryName: 'x', note: '', date: date('2020-01-12'), accountText: null, ownerMemberId: null, bookTo: 'FAMILY', segment: '' },
      { type: 'TX', txType: 'EXPENSE', amount: 519, originalCurrency: 'USD', originalAmount: 15.99, amountEstimated: true, categoryName: 'x', note: '', date: date('2019-12-10'), accountText: null, ownerMemberId: null, bookTo: 'FAMILY', segment: '' },
    ],
  };
  await fx.applyFxToPlan(plan, ENV);
  assert.equal(plan.items[0].amount, 482); // 15.99 × 30.15 = 482.0985
  assert.deepEqual(plan.items[0].fx, { rate: 30.15, basis: 'CUSTOMS_SELL', rateDate: '2020-01-11' });
  assert.equal(plan.items[1].amount, 120);
  assert.equal(plan.items[1].fx, undefined);
  assert.equal(plan.items[2].amount, 510); // 15.99 × 31.9（env）= 510.081
  assert.equal(plan.items[2].fx.basis, 'ENV');
});

test('來源拒絕存取：只打一次、標 refused、冷卻 12 小時內不再打；格式異常只記失敗不冷卻', { skip: SKIP }, async () => {
  fx.resetFxStatusForTest();
  let calls = 0;
  const refused = async () => {
    calls++;
    return { kind: 'refused' as const, reason: 'source refused access (http 200, challenge/block page)' };
  };
  // 2020-03-02（一）17:00 台北：最後資料是 02-03 的臺銀那筆
  const r1 = await fx.syncFxRates({ now: at('2020-03-02T09:00:00Z'), fetcher: refused });
  assert.equal(calls, 1);
  assert.equal(r1.refused, true);
  assert.equal(r1.skipped, null);
  const h = fx.fxHealth();
  assert.match(h.lastError ?? '', /portal\.sw\.nat\.gov\.tw: source refused access/);
  assert.equal(h.refusedUntil, '2020-03-02T21:00:00.000Z');
  assert.equal(h.missingBusinessDays, 20); // 02-04～03-02 的平日
  // 冷卻中：不打
  const r2 = await fx.syncFxRates({ now: at('2020-03-02T20:59:00Z'), fetcher: refused });
  assert.equal(calls, 1);
  assert.equal(r2.refused, true);
  assert.match(r2.skipped ?? '', /not retrying until 2020-03-02T21:00:00.000Z/);
  // 冷卻過了：再試一次；這次格式異常 → 只記失敗、不冷卻
  const r3 = await fx.syncFxRates({ now: at('2020-03-02T21:00:00Z'), fetcher: async () => ({ kind: 'error' as const, reason: 'no USD row' }) });
  assert.equal(r3.refused, false);
  assert.equal(r3.failed, 'no USD row');
  assert.equal(fx.fxHealth().refusedUntil, '2020-03-02T21:00:00.000Z'); // 沒延長
  // 記帳照樣能換（02-03 那筆在 30 天內）
  assert.equal((await fx.quoteFx('USD', '2020-03-02', ENV))!.rateDate, '2020-02-03');
  // 成功一次就解除冷卻
  await fx.syncFxRates({ now: at('2020-03-03T09:00:00Z'), fetcher: async () => period('2020-03-01', '2020-03-10', 30.3) });
  assert.equal(fx.fxHealth().refusedUntil, null);
  assert.equal(fx.fxHealth().lastError, null);
  assert.equal(fx.fxHealth().missingBusinessDays, 0);
});
