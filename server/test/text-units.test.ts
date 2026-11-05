// 遮罩（送 Gemini 前）、日期換算（台北時區）、原句抓金額的單元測試。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSensitive } from '../src/lib/mask';
import { resolveDateText, findDateText } from '../src/lib/date-text';
import { extractAmounts, chineseToNumber, currencyCode, estimateTwd } from '../src/lib/amount-text';

// ---- 遮罩 ----
test('遮罩：卡號（連續／每 4 碼隔開）→ 只留末四碼', () => {
  for (const s of ['4111111111111234', '4111 1111 1111 1234', '4111-1111-1111-1234', '３５６６１１１１１１１１１２３４']) {
    const m = maskSensitive(`刷 ${s} 午餐 120`);
    assert.ok(m.text.includes('[卡號末4:1234]'), `${s} → ${m.text}`);
    assert.ok(!/\d{6,}/.test(m.text.replace('120', '')), m.text);
    assert.ok(m.text.includes('120'), '金額要留著');
  }
});

test('遮罩：帳號（10～12 碼、或用 - 隔開）、身分證、手機', () => {
  const m = maskSensitive('轉到 808-12-3456789-0 和 1234567890 身分證 A123456789 手機 0912-345-678 金額 24261');
  assert.ok(m.text.includes('[帳號末4:7890]'), m.text);
  assert.ok(m.text.includes('[帳號末4:7890]'));
  assert.ok(m.text.includes('[身分證]'));
  assert.ok(m.text.includes('[手機]'));
  assert.ok(m.text.includes('24261'));
  assert.equal(m.counts.idNumber, 1);
  assert.equal(m.counts.mobile, 1);
  assert.equal(m.counts.account, 2);
  assert.ok(!m.text.includes('A123456789'));
  assert.ok(!m.text.includes('3456789'));
});

test('遮罩：金額、日期、小數、千分位、幾個並排的小數字都不能被遮', () => {
  for (const s of ['繳國泰卡 24,261', '還房貸 1,000,000', 'Zoom 15.99 美金', '2026-10-03 加油 1200', '早餐 80 120 300 450', '存 2 萬', '10/3 晚餐 300']) {
    assert.equal(maskSensitive(s).text, s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)), s);
  }
});

// ---- 日期 ----
const NOW = new Date('2026-11-05T10:00:00+08:00'); // 週四
const d = (raw: string, now = NOW) => resolveDateText(raw, now);

test('日期：今天、昨天、前天、大前天、N 天前', () => {
  assert.equal(d('今天').ymd, '2026-11-05');
  assert.equal(d('昨天').ymd, '2026-11-04');
  assert.equal(d('前天').ymd, '2026-11-03');
  assert.equal(d('大前天').ymd, '2026-11-02');
  assert.equal(d('3天前').ymd, '2026-11-02');
  assert.equal(d('三天前').ymd, '2026-11-02');
});

test('日期：台北時區——UTC 前一天 16:30（＝台北 00:30）說「昨天」是台北的昨天', () => {
  const now = new Date('2026-11-04T16:30:00Z'); // 台北 11/5 00:30
  assert.equal(d('昨天', now).ymd, '2026-11-04');
  assert.equal(d('今天', now).ymd, '2026-11-05');
});

test('日期：星期幾（週一為一週開始）', () => {
  assert.equal(d('上週五').ymd, '2026-10-30');
  assert.equal(d('上星期五').ymd, '2026-10-30');
  assert.equal(d('上禮拜天').ymd, '2026-11-01');
  assert.equal(d('上上週一').ymd, '2026-10-19');
  assert.equal(d('週二').ymd, '2026-11-03', '本週已過的週二');
  assert.equal(d('週五').ymd, '2026-10-30', '本週還沒到 → 上週五');
  assert.equal(d('這週五').ok, false, '這週五還沒到＝未來 → 換不出來');
  assert.equal(d('禮拜四').ymd, '2026-11-05', '今天');
});

test('日期：M/D、M月D日、YYYY/M/D、民國年、N號', () => {
  assert.equal(d('10/3').ymd, '2026-10-03');
  assert.equal(d('10-3').ymd, '2026-10-03');
  assert.equal(d('10月3日').ymd, '2026-10-03');
  assert.equal(d('十月三號').ymd, '2026-10-03');
  assert.equal(d('2026/10/3').ymd, '2026-10-03');
  assert.equal(d('2025年12月31日').ymd, '2025-12-31');
  assert.equal(d('115/10/3').ymd, '2026-10-03');
  assert.equal(d('3號').ymd, '2026-11-03');
  assert.equal(d('20號').ymd, '2026-10-20', '本月 20 號還沒到 → 上個月');
});

test('日期：沒寫年份且換算後在未來 → 往前推一年；跨年', () => {
  assert.equal(d('12/25').ymd, '2025-12-25');
  const jan2 = new Date('2027-01-02T09:00:00+08:00');
  assert.equal(d('12/30', jan2).ymd, '2026-12-30');
  assert.equal(d('1/1', jan2).ymd, '2027-01-01');
  assert.equal(d('昨天', new Date('2027-01-01T09:00:00+08:00')).ymd, '2026-12-31');
  assert.equal(d('上週五', jan2).ymd, '2026-12-25');
});

test('日期：換不出來 → ok=false、ymd＝今天；未來、亂寫、2/30 都不收', () => {
  for (const raw of ['下禮拜', '月底', '明天', '2/30', '2027/1/1', 'abc']) {
    const r = d(raw);
    assert.equal(r.ok, false, raw);
    assert.equal(r.ymd, '2026-11-05', raw);
    assert.equal(r.explicit, true, raw);
  }
  assert.equal(d('').explicit, false);
});

test('日期：閏年 2/29（2028 是閏年）', () => {
  assert.equal(d('2/29', new Date('2028-03-01T09:00:00+08:00')).ymd, '2028-02-29');
  assert.equal(d('2/29').ok, false, '2026、2025 都不是閏年');
});

test('從句子用規則找日期原文', () => {
  assert.equal(findDateText('昨天早餐 80'), '昨天');
  assert.equal(findDateText('10/3 加油 1200'), '10/3');
  assert.equal(findDateText('上週五 電影 600'), '上週五');
  assert.equal(findDateText('午餐 120'), null);
});

// ---- 金額 ----
test('原句抓金額：千分位、小數、萬／千、中文數字，日期與末四碼不算', () => {
  assert.deepEqual(extractAmounts('從臺銀繳國泰卡 24,261'), [24261]);
  assert.deepEqual(extractAmounts('存 2 萬到將來定存'), [20000]);
  assert.deepEqual(extractAmounts('存2萬5到定存'), [25000]);
  assert.deepEqual(extractAmounts('1.5萬'), [15000]);
  assert.deepEqual(extractAmounts('Apple 轉一萬給我'), [10000]);
  assert.deepEqual(extractAmounts('三千五'), [3500]);
  assert.deepEqual(extractAmounts('公司 Zoom 15.99 美金'), [15.99]);
  assert.deepEqual(extractAmounts('10/3 加油 1200'), [1200]);
  assert.deepEqual(extractAmounts('2026-10-03 加油 1200'), [1200]);
  assert.deepEqual(extractAmounts('繳 1234 那張卡 3000'), [3000]);
  assert.deepEqual(extractAmounts('還房貸 18000（本金 12000 利息 6000）'), [18000, 12000, 6000]);
  assert.deepEqual(extractAmounts('早餐 豆漿25 蛋餅35'), [25, 35]);
  assert.deepEqual(extractAmounts('５０００'), [5000]);
  assert.deepEqual(extractAmounts('$120 午餐'), [120]);
  assert.deepEqual(extractAmounts('吃午餐花了 120 元'), [120]);
  assert.deepEqual(extractAmounts('3天前 晚餐 300'), [300]);
  assert.deepEqual(extractAmounts('刷 [卡號末4:1234] 午餐 120'), [120]);
});

test('中文數字', () => {
  assert.equal(chineseToNumber('一萬'), 10000);
  assert.equal(chineseToNumber('一萬二'), 12000);
  assert.equal(chineseToNumber('兩萬五千'), 25000);
  assert.equal(chineseToNumber('三千零五'), 3005);
  assert.equal(chineseToNumber('十二'), 12);
  assert.equal(chineseToNumber('兩百五'), 250);
});

test('幣別與預估台幣', () => {
  assert.equal(currencyCode('美金'), 'USD');
  assert.equal(currencyCode('US$'), 'USD');
  assert.equal(currencyCode('日圓'), 'JPY');
  assert.equal(currencyCode('台幣'), 'TWD');
  assert.equal(currencyCode('越盾'), null);
  assert.equal(estimateTwd(15.99, 'USD', { USD: 32.5 }), 520);
  assert.equal(estimateTwd(10, 'XYZ', { USD: 32.5 }), null);
});
