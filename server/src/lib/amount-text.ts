// 從原句用規則抓金額，跟 Gemini 解析出的金額互相比對（規格 3.10.2：Gemini 的金額只當解析結果，
// 程式再從原句抓一次，不一致就問）。另含幣別原文 → ISO 代碼對照、參考匯率估台幣。
//
// 金額寫法：120、$120、120元／塊、24,261、15.99、2萬、1.5萬、2 萬 5、3千、三千、一萬二、5k。
// 不算金額：日期（10/3、2026-10-03、10月3日）、時間（12:30）、遮罩代號（[卡號末4:1234]）、
// 「1234 那張」這種末四碼（後面接「那張／末四碼」）、星期幾、「N 天前」。

import { DEFAULT_FX_RATES, convertToTwd, envFxRates } from './fx-rates';

const CN_NUM: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** 中文數字（含「一萬二」「三千五」「兩百」）→ 數字；不合法 NaN */
export function chineseToNumber(s: string): number {
  if (!s || !/^[零〇一二兩三四五六七八九十百千萬]+$/.test(s)) return NaN;
  let total = 0;
  let section = 0;
  let digit = -1;
  let lastUnit = 1;
  for (const ch of s) {
    if (ch in CN_NUM) {
      digit = CN_NUM[ch];
    } else if (ch in CN_UNIT) {
      const u = CN_UNIT[ch];
      section += (digit === -1 ? 1 : digit) * u;
      digit = -1;
      lastUnit = u;
    } else if (ch === '萬') {
      section += digit === -1 ? 0 : digit;
      total += (section === 0 ? 1 : section) * 10000;
      section = 0;
      digit = -1;
      lastUnit = 10000; // 「一萬二」＝一萬二千（尾數＝下一級單位）
    }
  }
  if (digit !== -1) {
    // 尾數省略單位：「三千五」＝3500、「一萬二」＝12000、「兩百五」＝250
    section += lastUnit >= 10 && s.length > 1 && !(s[s.length - 2] in CN_NUM) ? digit * (lastUnit / 10) : digit;
  }
  return total + section;
}

function toHalf(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，]/g, ',')
    .replace(/[．]/g, '.')
    .replace(/[＄]/g, '$');
}

/** 抓出句子裡所有「可能是金額」的數字（去重，保留順序）。 */
export function extractAmounts(sentence: string): number[] {
  let s = toHalf(sentence);
  // 拿掉不是金額的東西
  s = s
    .replace(/\[[^\]]*\]/g, ' ') // 遮罩代號
    .replace(/\d{3,4}[/.\-年]\d{1,2}[/.\-月]\d{1,2}[日號号]?/g, ' ') // 有年份的日期
    .replace(/(?<![\d.])\d{1,2}\/\d{1,2}(?![\d.])/g, ' ') // M/D
    .replace(/\d{1,2}月\d{1,2}[日號号]?/g, ' ')
    .replace(/(?<![\d.])\d{1,2}[日號号](?![\d])/g, ' ')
    .replace(/\d{1,2}:\d{2}/g, ' ') // 時間
    .replace(/\d+\s*天前/g, ' ')
    .replace(/(?<!\d)\d{4}\s*(?:那張|那個|末四碼|尾數|結尾)/g, ' ') // 末四碼
    .replace(/(?:末四碼|尾數|末4碼?)\s*\d{4}/g, ' ');

  const out: number[] = [];
  const push = (n: number) => {
    if (!Number.isFinite(n) || n <= 0) return;
    const r = Math.round(n * 100) / 100;
    if (!out.includes(r)) out.push(r);
  };

  // 阿拉伯數字（可帶千分位、小數）＋可選的 萬／千／k，以及「2 萬 5」這種尾數
  const re = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(萬|千|[kK](?![a-zA-Z]))?(?:\s*([一二三四五六七八九\d])(?![\d.,萬千元塊]))?/g;
  let m: RegExpExecArray | null;
  const spans: [number, number][] = [];
  while ((m = re.exec(s))) {
    spans.push([m.index, m.index + m[0].length]);
    let n = Number(m[1].replace(/,/g, '') + (m[2] ? `.${m[2]}` : ''));
    const unit = m[3];
    if (unit === '萬') {
      n *= 10000;
      if (m[4]) n += (/\d/.test(m[4]) ? Number(m[4]) : CN_NUM[m[4]]) * 1000; // 2萬5＝25000
    } else if (unit === '千') {
      n *= 1000;
      if (m[4]) n += (/\d/.test(m[4]) ? Number(m[4]) : CN_NUM[m[4]]) * 100;
    } else if (unit === 'k' || unit === 'K') {
      n *= 1000;
    } else if (m[4]) {
      // 沒有單位，後面那個字不是尾數 → 退回只吃數字本身，讓下一輪從那個字開始
      re.lastIndex = m.index + m[0].length - m[4].length;
    }
    push(n);
  }

  // 阿拉伯數字吃過的範圍（含「2 萬」的萬）挖掉，再找中文數字
  for (const [a, b] of spans) s = s.slice(0, a) + ' '.repeat(b - a) + s.slice(b);
  // 中文數字金額（至少要有 十／百／千／萬 單位，避免把「一筆」「三明治」的單字當金額；單獨一個「萬」「千」也不算）
  const cn = /[零〇一二兩三四五六七八九十百千萬]*[十百千萬][零〇一二兩三四五六七八九十百千萬]*/g;
  while ((m = cn.exec(s))) {
    // 「十月」「十號」是日期，「上週」等已在前面處理
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 1);
    if (/[月日號号點]/.test(after)) continue;
    const before = s.slice(Math.max(0, m.index - 1), m.index);
    if (/[週周期拜]/.test(before)) continue;
    if (!/[零〇一二兩三四五六七八九]/.test(m[0]) && !m[0].startsWith('十')) continue;
    push(chineseToNumber(m[0]));
  }
  return out;
}

/** Gemini 給的金額有沒有出現在原句裡（容許 0.005 的浮點誤差）。 */
export function amountInSentence(amount: number, found: number[]): boolean {
  return found.some((x) => Math.abs(x - amount) < 0.005);
}

// ---- 幣別 ----

const CURRENCY_WORDS: [RegExp, string][] = [
  [/美金|美元|美刀|usd|us\$|u\$/i, 'USD'],
  [/日圓|日元|日幣|円|jpy|yen/i, 'JPY'],
  [/歐元|eur|€/i, 'EUR'],
  [/人民幣|rmb|cny/i, 'CNY'],
  [/港幣|港元|hkd/i, 'HKD'],
  [/韓元|韓幣|krw|₩/i, 'KRW'],
  [/英鎊|gbp|£/i, 'GBP'],
  [/澳幣|澳元|aud/i, 'AUD'],
  [/新幣|新加坡幣|sgd/i, 'SGD'],
  [/泰銖|thb/i, 'THB'],
  [/台幣|臺幣|新台幣|新臺幣|twd|ntd|nt\$/i, 'TWD'],
];

/** 幣別原文（「美金」「日圓」「USD」）→ ISO 4217；不認得回 null；台幣回 'TWD'。 */
export function currencyCode(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  for (const [re, code] of CURRENCY_WORDS) if (re.test(s)) return code;
  return null;
}

/** 片段裡有沒有寫外幣字樣（程式自己判斷，不完全靠 Gemini） */
export function currencyInText(segment: string): string | null {
  const code = currencyCode(segment);
  return code && code !== 'TWD' ? code : null;
}

/**
 * 參考匯率的「同步退路」（1 單位外幣＝多少台幣）：env FX_REFERENCE_RATES 蓋過固定值。
 * 正式來源是臺銀牌告（services/fx.ts，記帳時依消費日查 FxRateDaily 再覆寫）；這裡只給計畫階段先估、與查不到時用。
 */
export function referenceRates(env: NodeJS.ProcessEnv = process.env): Record<string, number> {
  return { ...DEFAULT_FX_RATES, ...envFxRates(env) };
}

/** 原幣 → 預估台幣（四捨五入到元）。不認得的幣別回 null（呼叫端要問）。 */
export function estimateTwd(amount: number, currency: string, rates: Record<string, number> = referenceRates()): number | null {
  if (currency === 'TWD') return Math.round(amount * 100) / 100;
  const r = rates[currency];
  if (!r) return null;
  return convertToTwd(amount, r);
}
