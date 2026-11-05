// 文字記帳的日期換算（規格 3.10.5）：Gemini 只回日期「原文」（「昨天」「10/3」「上週五」），這裡用程式換成台北日期。
//
// 規則：
// - 一律以台北時區的「今天」為基準（不依賴主機 TZ）。
// - 支援：今天／今日、昨天／昨日、前天、大前天、N 天前；（上／上上／這／本）週X、星期X、禮拜X、週X；
//   M/D、M-D、M.D、M月D日（號）、YYYY/M/D、YYYY-M-D、YYYY年M月D日、民國 YYY/M/D（3 碼年＋1911）。
// - 沒寫年份：先放今年，換算出來在未來就往前推一年（12/30 在 1/2 說「12/30 聚餐」＝去年）。
// - 只說「週五」不說上週：本週的週五；在未來就算上週的。
// - 換不出來（「下禮拜」「月底」或亂寫）→ ok=false，呼叫端記成今天並在回覆標出「日期是今天，要改嗎」。
// - 換出來是未來（明天、寫了年份的未來日期）→ 一樣當換不出來處理（記帳只記已發生的）。

const DAY_MS = 24 * 60 * 60 * 1000;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface ResolvedDate {
  ymd: string; // 台北日期 YYYY-MM-DD
  ok: boolean; // false＝沒寫日期或換不出來，ymd＝今天
  explicit: boolean; // 使用者有寫日期（含「今天」）
  raw: string;
}

function taipeiParts(d: Date): { y: number; m: number; d: number; dow: number } {
  const t = new Date(d.getTime() + TAIPEI_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymdOf = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** 台北某天往前／往後 n 天 */
function shiftYmd(y: number, m: number, d: number, days: number): string {
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return ymdOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 「十二」「二十三」「三十一」「5」→ 數字；不合法回 NaN */
export function smallNumber(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[零〇一二兩三四五六七八九十]+$/.test(s)) return NaN;
  if (s === '十') return 10;
  const i = s.indexOf('十');
  if (i === -1) return s.length === 1 ? CN_DIGIT[s] : NaN;
  const tens = i === 0 ? 1 : CN_DIGIT[s.slice(0, i)];
  const ones = i === s.length - 1 ? 0 : CN_DIGIT[s.slice(i + 1)];
  return tens * 10 + ones;
}

const WEEKDAY: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 0 };

function normalize(raw: string): string {
  return raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[／]/g, '/')
    .replace(/[－—–]/g, '-')
    .replace(/\s+/g, '')
    .trim();
}

export function resolveDateText(rawInput: string | null | undefined, now: Date = new Date()): ResolvedDate {
  const today = taipeiParts(now);
  const todayYmd = ymdOf(today.y, today.m, today.d);
  const raw = (rawInput ?? '').trim();
  const none: ResolvedDate = { ymd: todayYmd, ok: false, explicit: false, raw };
  if (!raw) return none;
  const s = normalize(raw);
  const fail: ResolvedDate = { ymd: todayYmd, ok: false, explicit: true, raw };
  const done = (ymd: string): ResolvedDate => (ymd > todayYmd ? fail : { ymd, ok: true, explicit: true, raw });

  if (/^(今天|今日|今早|今晚|今天早上|今天中午|今天晚上)$/.test(s)) return done(todayYmd);
  if (/^(昨天|昨日|昨晚|昨天早上|昨天中午|昨天晚上)$/.test(s)) return done(shiftYmd(today.y, today.m, today.d, -1));
  if (/^(前天|前日)$/.test(s)) return done(shiftYmd(today.y, today.m, today.d, -2));
  if (/^大前天$/.test(s)) return done(shiftYmd(today.y, today.m, today.d, -3));
  let m = /^([0-9]+|[一二兩三四五六七八九十]+)天前$/.exec(s);
  if (m) {
    const n = smallNumber(m[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 366) return done(shiftYmd(today.y, today.m, today.d, -n));
    return fail;
  }

  // 週：上上週五／上週五／上星期五／上禮拜五／這週五／本週五／週五／星期五／禮拜天
  m = /^(上上|上|這|本|这)?(?:個)?(週|周|星期|禮拜|礼拜)([一二三四五六日天1-7])$/.exec(s);
  if (m) {
    const target = WEEKDAY[m[3]];
    if (target === undefined) return fail;
    // 以週一為一週開始：今天是本週第幾天（週一=0 … 週日=6）
    const idx = (today.dow + 6) % 7;
    const tIdx = (target + 6) % 7;
    const weeksBack = m[1] === '上上' ? 2 : m[1] === '上' ? 1 : 0;
    let delta = tIdx - idx - 7 * weeksBack;
    if (!m[1] && delta > 0) delta -= 7; // 只說「週五」而本週週五還沒到 → 上週五
    if ((m[1] === '這' || m[1] === '本' || m[1] === '这') && delta > 0) return fail; // 本週還沒到的那天＝未來
    return done(shiftYmd(today.y, today.m, today.d, delta));
  }

  // 有年份：YYYY/M/D、YYYY-M-D、YYYY.M.D、YYYY年M月D日；民國 YYY/M/D
  m = /^(\d{3,4})[/.-年](\d{1,2})[/.-月](\d{1,2})[日號号]?$/.exec(s);
  if (m) {
    let y = Number(m[1]);
    if (m[1].length === 3) y += 1911;
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!validYmd(y, mo, d)) return fail;
    return done(ymdOf(y, mo, d));
  }

  // 沒年份：M/D、M-D、M.D、M月D日（號），月日也可以是中文數字（十月三日）
  m = /^(\d{1,2}|[一二三四五六七八九十]+)(?:[/.-]|月)(\d{1,2}|[一二三四五六七八九十]+)[日號号]?$/.exec(s);
  if (m) {
    const mo = smallNumber(m[1]);
    const d = smallNumber(m[2]);
    if (!Number.isFinite(mo) || !Number.isFinite(d)) return fail;
    let y = today.y;
    if (!validYmd(y, mo, d)) {
      // 2/29 今年沒有 → 試去年（前一個閏年不一定是去年，再不合法就失敗）
      if (!validYmd(y - 1, mo, d)) return fail;
      y -= 1;
    }
    let ymd = ymdOf(y, mo, d);
    if (ymd > todayYmd) {
      if (!validYmd(y - 1, mo, d)) return fail;
      ymd = ymdOf(y - 1, mo, d);
    }
    return done(ymd);
  }

  // 只有「N 號／N 日」：本月 N 號，未來就算上個月
  m = /^(\d{1,2}|[一二三四五六七八九十]+)[日號号]$/.exec(s);
  if (m) {
    const d = smallNumber(m[1]);
    if (!Number.isFinite(d)) return fail;
    let y = today.y;
    let mo = today.m;
    if (!validYmd(y, mo, d) || ymdOf(y, mo, d) > todayYmd) {
      mo -= 1;
      if (mo === 0) {
        mo = 12;
        y -= 1;
      }
      if (!validYmd(y, mo, d)) return fail;
    }
    return done(ymdOf(y, mo, d));
  }

  return fail;
}

/**
 * 從句子（或一筆的片段）用規則抓出日期原文，給「Gemini 漏回日期」與「Gemini 回的日期原文不在原句裡」的檢查用。
 * 只認上面 resolveDateText 會換的寫法；找不到回 null。
 */
const DATE_PATTERNS: RegExp[] = [
  /大前天|前天|昨天|昨日|昨晚|今天|今日|今晚|今早/,
  /(?:上上|上|這|本)?(?:個)?(?:週|周|星期|禮拜)[一二三四五六日天]/,
  /[0-9]+天前/,
  /\d{3,4}[/.\-年]\d{1,2}[/.\-月]\d{1,2}[日號号]?/,
  /(?<![\d.])\d{1,2}\/\d{1,2}(?![\d.])/,
  /\d{1,2}月\d{1,2}[日號号]?/,
];

export function findDateText(sentence: string): string | null {
  const s = normalize(sentence);
  for (const re of DATE_PATTERNS) {
    const m = re.exec(s);
    if (m) return m[0];
  }
  return null;
}

/** YYYY-MM-DD → 台北當天中午（存 DateTime；同 lib/time-tw taipeiNoon，但給已驗證的字串用）。 */
export function noonOf(ymd: string): Date {
  return new Date(`${ymd}T12:00:00+08:00`);
}
