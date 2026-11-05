// 台北日期少一天 bug 回歸測試。用 TZ=UTC 與 TZ=Asia/Taipei 各跑一輪都要綠。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ymdTaipei } from '../src/lib/time-tw';
import { nextDueDate } from '../src/services/creditcard';

// 以台北當地時間建立「現在」
const tp = (ymd: string, hm = '10:00') => new Date(`${ymd}T${hm}:00+08:00`);

test('ymdTaipei：台北 00:00 不會變成前一天', () => {
  assert.equal(ymdTaipei(tp('2026-11-05', '00:00')), '2026-11-05');
  assert.equal(ymdTaipei(tp('2026-11-05', '23:59')), '2026-11-05');
});

test('CSV 日期：paidAt 在台北 01:00（UTC 前一天 17:00）要算當天', () => {
  const paidAtIso = '2026-11-04T17:00:00.000Z'; // = 台北 2026-11-05 01:00
  assert.equal(paidAtIso.slice(0, 10), '2026-11-04'); // 舊寫法的錯誤結果
  assert.equal(ymdTaipei(new Date(paidAtIso)), '2026-11-05');
  // 跨月 / 跨年邊界
  assert.equal(ymdTaipei(new Date('2026-11-30T16:00:00.000Z')), '2026-12-01');
  assert.equal(ymdTaipei(new Date('2026-12-31T16:30:00.000Z')), '2027-01-01');
  assert.equal(ymdTaipei(new Date('2026-11-04T15:59:59.999Z')), '2026-11-04');
});

test('nextDueDate：dueDay=15 當月尚未到', () => {
  assert.equal(nextDueDate(15, tp('2026-11-05')), '2026-11-15');
  // 台北清晨（UTC 還是前一天）
  assert.equal(nextDueDate(15, tp('2026-11-05', '00:30')), '2026-11-15');
});

test('nextDueDate：今天就是繳款日，回今天', () => {
  assert.equal(nextDueDate(15, tp('2026-11-15', '07:00')), '2026-11-15');
  assert.equal(nextDueDate(15, tp('2026-11-15', '23:30')), '2026-11-15');
});

test('nextDueDate：dueDay=1 不會顯示成上個月最後一天', () => {
  assert.equal(nextDueDate(1, tp('2026-11-05')), '2026-12-01');
  assert.equal(nextDueDate(1, tp('2026-12-01', '00:10')), '2026-12-01');
});

test('nextDueDate：31 號遇到 30 天的月份取月底', () => {
  assert.equal(nextDueDate(31, tp('2026-11-05')), '2026-11-30');
  assert.equal(nextDueDate(31, tp('2026-04-10')), '2026-04-30');
});

test('nextDueDate：2 月取 28 / 29 日', () => {
  assert.equal(nextDueDate(31, tp('2027-02-03')), '2027-02-28');
  assert.equal(nextDueDate(30, tp('2027-02-03')), '2027-02-28');
  assert.equal(nextDueDate(31, tp('2028-02-03')), '2028-02-29'); // 閏年
});

test('nextDueDate：今天已過繳款日跳到下個月', () => {
  assert.equal(nextDueDate(15, tp('2026-11-16')), '2026-12-15');
  assert.equal(nextDueDate(5, tp('2026-12-20')), '2027-01-05'); // 跨年
  assert.equal(nextDueDate(30, tp('2027-01-31')), '2027-02-28'); // 跳到 2 月要夾到月底
});
