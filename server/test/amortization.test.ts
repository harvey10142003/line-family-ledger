// 攤還計算（lib/amortization.ts）：手算範例逐期比對、捨入規則、寬限期、利率變動。不需要資料庫。
// 手算過程寫在每個斷言旁邊，數字以「元」為單位，誤差要求 0（規格驗收是 ≤ 1 元）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSchedule,
  equalPayment,
  expectedBalanceAt,
  nextPeriod,
  periodDate,
  rateAt,
  round2,
  roundYuan,
  signedLiabilityAmount,
  suggestSplit,
} from '../src/lib/amortization';

const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100;

test('捨入：四捨五入到元（.5 進位、浮點誤差不吃掉 .5）', () => {
  assert.equal(roundYuan(1666.6667), 1667);
  assert.equal(roundYuan(1661.0133), 1661);
  assert.equal(roundYuan(0.5), 1);
  assert.equal(roundYuan(0.49), 0);
  assert.equal(roundYuan(1234.5), 1235);
  assert.equal(roundYuan(1.005 * 1000), 1005); // 1004.9999999999999 這種浮點表示也要進到 1005
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(roundYuan(-2.5), -3); // 負數對稱（不會用到，但不能出怪值）
});

test('本息平均：100 萬、年利率 2%、20 年（240 期）— 前 3 期手算', () => {
  // 月利率 r = 0.02/12 = 0.0016667；月付金 = 1,000,000 × r(1+r)^240 / ((1+r)^240 − 1) = 5,058.83 → 5,059
  assert.equal(equalPayment(1_000_000, 0.02 / 12, 240), 5059);
  const s = buildSchedule({ principal: 1_000_000, annualRatePct: 2, termMonths: 240, method: 'EQUAL_PAYMENT', firstPaymentDate: '2026-01-10' });
  assert.equal(s.length, 240);
  // 第 1 期：利息 1,000,000 × r = 1,666.67 → 1,667；本金 5,059 − 1,667 = 3,392；剩 996,608
  assert.deepEqual([s[0].payment, s[0].interest, s[0].principal, s[0].balance], [5059, 1667, 3392, 996608]);
  // 第 2 期：利息 996,608 × r = 1,661.01 → 1,661；本金 3,398；剩 993,210
  assert.deepEqual([s[1].payment, s[1].interest, s[1].principal, s[1].balance], [5059, 1661, 3398, 993210]);
  // 第 3 期：利息 993,210 × r = 1,655.35 → 1,655；本金 3,404；剩 989,806
  assert.deepEqual([s[2].payment, s[2].interest, s[2].principal, s[2].balance], [5059, 1655, 3404, 989806]);
  assert.equal(s[1].date, '2026-02-10');
  // 最後一期把剩餘本金還清（吸收捨入差），本金合計＝原始本金
  const last = s[239];
  assert.equal(last.balance, 0);
  assert.equal(sum(s.map((r) => r.principal)), 1_000_000);
  // 每期本金＋利息＝應繳
  for (const r of s) assert.equal(round2(r.principal + r.interest), r.payment);
  // 除最後一期外月付金固定
  assert.ok(s.slice(0, 239).every((r) => r.payment === 5059));
});

test('本金平均：12 萬、年利率 6%、12 期 — 每期本金 1 萬，利息逐期遞減 50', () => {
  // 月利率 0.5%；第 1 期利息 120,000 × 0.5% = 600，第 2 期 110,000 × 0.5% = 550 … 第 12 期 10,000 × 0.5% = 50
  const s = buildSchedule({ principal: 120_000, annualRatePct: 6, termMonths: 12, method: 'EQUAL_PRINCIPAL', firstPaymentDate: '2026-01-05' });
  assert.deepEqual(
    s.map((r) => r.interest),
    [600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100, 50],
  );
  assert.ok(s.every((r) => r.principal === 10_000));
  assert.equal(sum(s.map((r) => r.interest)), 3900); // 50 × (1+2+…+12) = 50 × 78
  assert.equal(s[11].balance, 0);
});

test('本金平均：除不盡時每期四捨五入，最後一期吸收差額', () => {
  // 100,000 ÷ 3 = 33,333.33 → 33,333；最後一期 100,000 − 66,666 = 33,334
  const s = buildSchedule({ principal: 100_000, annualRatePct: 0, termMonths: 3, method: 'EQUAL_PRINCIPAL', firstPaymentDate: '2026-01-05' });
  assert.deepEqual(s.map((r) => r.principal), [33333, 33333, 33334]);
  assert.ok(s.every((r) => r.interest === 0));
});

test('寬限期：120 萬、2.4%、36 期、前 12 期只繳息', () => {
  // 月利率 0.2%；寬限期每期利息 1,200,000 × 0.2% = 2,400、本金 0
  const s = buildSchedule({
    principal: 1_200_000,
    annualRatePct: 2.4,
    termMonths: 36,
    gracePeriodMonths: 12,
    method: 'EQUAL_PAYMENT',
    firstPaymentDate: '2026-01-31',
  });
  for (const r of s.slice(0, 12)) {
    assert.deepEqual([r.isGrace, r.principal, r.interest, r.balance], [true, 0, 2400, 1_200_000]);
  }
  // 第 13 期起在剩下 24 期攤還：1,200,000 × 0.002 × 1.002^24 / (1.002^24 − 1) = 51,259.9 → 51,260
  assert.equal(equalPayment(1_200_000, 0.002, 24), 51260);
  assert.deepEqual([s[12].isGrace, s[12].payment, s[12].interest, s[12].principal], [false, 51260, 2400, 48860]);
  // 第 14 期：利息 1,151,140 × 0.2% = 2,302.28 → 2,302；本金 48,958
  assert.deepEqual([s[13].interest, s[13].principal, s[13].balance], [2302, 48958, 1_102_182]);
  assert.equal(s[13].date, '2027-02-28'); // 31 號遇到 2 月取月底
  assert.equal(s[35].balance, 0);
  assert.equal(sum(s.map((r) => r.principal)), 1_200_000);
});

test('寬限期＋本金平均：期滿後本金＝本金 ÷ 剩餘期數', () => {
  const s = buildSchedule({ principal: 60_000, annualRatePct: 12, termMonths: 6, gracePeriodMonths: 2, method: 'EQUAL_PRINCIPAL', firstPaymentDate: '2026-03-01' });
  // 寬限 2 期利息 60,000 × 1% = 600；之後 4 期每期本金 15,000，利息 600、450、300、150
  assert.deepEqual(s.map((r) => [r.principal, r.interest]), [
    [0, 600],
    [0, 600],
    [15000, 600],
    [15000, 450],
    [15000, 300],
    [15000, 150],
  ]);
});

test('只繳息（INTEREST_ONLY）：每期只繳息，最後一期還本', () => {
  // 50 萬、3%：每期利息 500,000 × 0.25% = 1,250；第 12 期 500,000＋1,250
  const s = buildSchedule({ principal: 500_000, annualRatePct: 3, termMonths: 12, method: 'INTEREST_ONLY', firstPaymentDate: '2026-01-15' });
  assert.ok(s.slice(0, 11).every((r) => r.principal === 0 && r.interest === 1250 && r.isGrace));
  assert.deepEqual([s[11].principal, s[11].interest, s[11].payment, s[11].balance], [500_000, 1250, 501_250, 0]);
});

test('無息：本息平均＝本金 ÷ 期數', () => {
  const s = buildSchedule({ principal: 12_000, annualRatePct: 0, termMonths: 12, method: 'EQUAL_PAYMENT', firstPaymentDate: '2026-01-15' });
  assert.ok(s.every((r) => r.payment === 1000 && r.interest === 0));
});

test('FREE（親友借款）沒有攤還表', () => {
  assert.deepEqual(buildSchedule({ principal: 5000, annualRatePct: 0, termMonths: 1, method: 'FREE', firstPaymentDate: '2026-01-01' }), []);
});

test('利率變動：生效日之後的那期起用新利率，以剩餘本金與剩餘期數重算月付金', () => {
  const base = { principal: 1_000_000, annualRatePct: 2, termMonths: 240, method: 'EQUAL_PAYMENT' as const, firstPaymentDate: '2026-01-10' };
  const before = buildSchedule(base);
  const s = buildSchedule({ ...base, rateChanges: [{ effectiveDate: '2027-01-01', annualRatePct: 2.5 }] });
  // 生效前 12 期與沒變動完全相同
  assert.deepEqual(s.slice(0, 12), before.slice(0, 12));
  assert.equal(s[11].balance, 958_917);
  // 第 13 期（2027-01-10）：利息 958,917 × 2.5%/12 = 1,997.74 → 1,998
  assert.equal(s[12].annualRatePct, 2.5);
  assert.equal(s[12].interest, 1998);
  // 新月付金＝以 958,917 在剩下 228 期、月利率 2.5%/12 重算（手算 5,287.6 → 5,288）
  const r = 0.025 / 12;
  const f = Math.pow(1 + r, 228);
  assert.equal(Math.round((958_917 * r * f) / (f - 1)), 5288);
  assert.equal(s[12].payment, 5288);
  assert.equal(s[12].principal, 5288 - 1998);
  assert.equal(s[239].balance, 0);
  assert.equal(sum(s.map((x) => x.principal)), 1_000_000);
  // 本金平均攤還：利率變動只改利息，不改每期本金
  const ep = buildSchedule({ principal: 120_000, annualRatePct: 6, termMonths: 12, method: 'EQUAL_PRINCIPAL', firstPaymentDate: '2026-01-05', rateChanges: [{ effectiveDate: '2026-07-01', annualRatePct: 12 }] });
  assert.ok(ep.every((x) => x.principal === 10_000));
  assert.equal(ep[5].interest, 350); // 6 月仍 6%
  assert.equal(ep[6].interest, 600); // 7 月起 12%：60,000 × 1%
});

test('利率變動：多筆取「生效日 ≤ 繳款日」的最後一筆；同一天生效當期就用', () => {
  const changes = [
    { effectiveDate: '2026-06-10', annualRatePct: 3 },
    { effectiveDate: '2026-03-01', annualRatePct: 2.5 },
  ];
  assert.equal(rateAt('2026-02-28', 2, changes), 2);
  assert.equal(rateAt('2026-03-01', 2, changes), 2.5);
  assert.equal(rateAt('2026-06-09', 2, changes), 2.5);
  assert.equal(rateAt('2026-06-10', 2, changes), 3);
});

test('繳款日：每月固定日，月底不足取月底；跨年', () => {
  assert.equal(periodDate('2026-01-31', 1), '2026-02-28');
  assert.equal(periodDate('2028-01-31', 1), '2028-02-29');
  assert.equal(periodDate('2026-01-31', 2), '2026-03-31');
  assert.equal(periodDate('2026-11-15', 2), '2027-01-15');
  assert.equal(periodDate('2026-01-05', 1, 20), '2026-02-20');
});

test('依攤還表推算今天應剩本金、下一期', () => {
  const s = buildSchedule({ principal: 120_000, annualRatePct: 6, termMonths: 12, method: 'EQUAL_PRINCIPAL', firstPaymentDate: '2026-01-05' });
  assert.equal(expectedBalanceAt(s, 120_000, '2026-01-04'), 120_000);
  assert.equal(expectedBalanceAt(s, 120_000, '2026-01-05'), 110_000);
  assert.equal(expectedBalanceAt(s, 120_000, '2026-03-20'), 90_000);
  assert.equal(nextPeriod(s, '2026-03-20')?.period, 4);
  assert.equal(nextPeriod(s, '2027-01-01'), null);
  assert.equal(expectedBalanceAt([], 5000, '2026-01-01'), null);
});

test('只知道總額時的建議拆法：利息＝剩餘本金 × 月利率，其餘算本金', () => {
  // 剩 996,608、2%：利息 1,661；總額 5,059 → 本金 3,398
  assert.deepEqual(suggestSplit(996_608, 2, 5059), { principal: 3398, interest: 1661, excess: 0 });
  // 繳的比利息還少：全部算利息
  assert.deepEqual(suggestSplit(996_608, 2, 1000), { principal: 0, interest: 1000, excess: 0 });
  // 繳的超過剩餘本金＋利息：多的回報 excess
  assert.deepEqual(suggestSplit(1000, 12, 2000), { principal: 1000, interest: 10, excess: 990 });
});

test('借出記成資產（正）、借入記成負債（負）', () => {
  assert.equal(signedLiabilityAmount('LENT', 5000), 5000);
  assert.equal(signedLiabilityAmount('BORROWED', 5000), -5000);
});

test('參數不合理丟錯', () => {
  assert.throws(() => buildSchedule({ principal: 1000, annualRatePct: 2, termMonths: 0, method: 'EQUAL_PAYMENT', firstPaymentDate: '2026-01-01' }));
  assert.throws(() => buildSchedule({ principal: 1000, annualRatePct: 2, termMonths: 12, gracePeriodMonths: 12, method: 'EQUAL_PAYMENT', firstPaymentDate: '2026-01-01' }));
  assert.throws(() => buildSchedule({ principal: 1000, annualRatePct: 2, termMonths: 12, method: 'EQUAL_PAYMENT', firstPaymentDate: '2026/01/01' }));
});
