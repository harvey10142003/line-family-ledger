// 外幣參考匯率（純函式，不碰 DB、不打網路）。
//
// 來源：財政部關務署「每旬報關匯率」（政府資料開放平臺 https://data.gov.tw/dataset/6708，
//   政府資料開放授權條款第 1 版、免費、每 10 日更新）。下載點（JSON，只有「當期」那一份）：
//   https://portal.sw.nat.gov.tw/APGQ/GC331!downLoad?formBean.downLoadFile=CURRENT_JSON
//
// 11-07 改用它：原本抓的臺銀牌告 CSV（rate.bot.com.tw）從 GCP 主機連過去只回防機器人驗證頁，
// 臺銀沒有提供程式存取用的官方 API／開放資料（data.gov.tw 只有年度彙整），不繞過它的驗證 → 換來源。
//
// JSON 格式（2026-11-07 查證）：
//   { "start":"20261111", "end":"20261120", "items":[ { "code":"USD", "buyValue":"32.83", "sellValue":"32.93" }, … ] }
//   - 一旬一份：上旬 1–10 日、中旬 11–20 日、下旬 21 日–月底。下一旬的數字會在當旬內先公布
//     （11-07 抓到的「CURRENT」已經是 11-11～11-20），所以每天抓一次就不會漏期。
//   - 數字是「1 單位外幣＝多少台幣」，29 幣（含 TWD=1）；記帳用到的 10 幣（USD JPY EUR CNY HKD KRW GBP AUD SGD THB）都有。
//   - 買賣價差跟臺銀即期牌告一樣（USD 32.83／32.93），賣出價即「臺銀即期賣出」那一級的數字。
//
// 換算口徑與臺銀牌告的差異：
//   - 臺銀：消費日當天（或前一營業日）收盤的即期賣出。
//   - 關務署：消費日所在那一旬的報關賣出匯率，整旬同一個數字，取樣時間比消費日早約 1～2 週。
//     匯率一週變動通常 <1%，信用卡實際匯率與海外手續費（約 1.5%）本來就不在這裡算 → 一律標 amountEstimated，
//     卡帳單進來後改實際扣款金額。
//   - 沒有現金價：只存 buy→spotBuy、sell→spotSell（FxRateDaily 欄位沿用，source='CUSTOMS'，rateDate＝該旬第一天）。
//   - DB 裡 11-07 之前的臺銀資料（source='BOT'）照舊可用，口徑標 BOT_SPOT_SELL／BOT_CASH_SELL。

export interface CustomsRateRow {
  currency: string;
  buy: number | null;
  sell: number | null;
}

export interface TenDayPeriod {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

export type CustomsJsonResult =
  | { kind: 'rates'; period: TenDayPeriod; rows: CustomsRateRow[] }
  | { kind: 'invalid'; reason: string }; // 不是預期的 JSON（挑戰頁、錯誤頁、改版、期別不對）

const pos = (v: unknown): number | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
};

const ymd8 = (v: unknown): string | null => {
  const m = typeof v === 'string' ? /^(\d{4})(\d{2})(\d{2})$/.exec(v.trim()) : null;
  if (!m) return null;
  const ymd = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${ymd}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== ymd ? null : ymd;
};

/** 月底那天（YYYY-MM-DD） */
function monthEnd(ymd: string): string {
  const d = new Date(`${ymd.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** 某天所在的旬：1–10、11–20、21–月底 */
export function tenDayPeriodOf(ymd: string): TenDayPeriod {
  const day = Number(ymd.slice(8, 10));
  const ym = ymd.slice(0, 7);
  if (day <= 10) return { start: `${ym}-01`, end: `${ym}-10` };
  if (day <= 20) return { start: `${ym}-11`, end: `${ym}-20` };
  return { start: `${ym}-21`, end: monthEnd(ymd) };
}

/** 中文期別：「11月中旬」 */
export function tenDayPeriodLabel(start: string): string {
  const day = Number(start.slice(8, 10));
  return `${Number(start.slice(5, 7))}月${day <= 10 ? '上' : day <= 20 ? '中' : '下'}旬`;
}

/** 解析關務署每旬報關匯率 JSON。期別必須剛好是一旬、至少要有 USD，否則 invalid。TWD 不存。 */
export function parseCustomsJson(text: string): CustomsJsonResult {
  const body = (text ?? '').replace(/^﻿/, '').trim();
  if (!body) return { kind: 'invalid', reason: 'empty body' };
  if (!body.startsWith('{')) return { kind: 'invalid', reason: `not JSON: ${body.slice(0, 60)}` };
  let o: any;
  try {
    o = JSON.parse(body);
  } catch {
    return { kind: 'invalid', reason: 'JSON parse error' };
  }
  const start = ymd8(o?.start);
  const end = ymd8(o?.end);
  if (!start || !end) return { kind: 'invalid', reason: `bad period ${String(o?.start)}-${String(o?.end)}` };
  const p = tenDayPeriodOf(start);
  if (p.start !== start || p.end !== end) return { kind: 'invalid', reason: `not a ten-day period ${start}~${end}` };
  if (!Array.isArray(o?.items)) return { kind: 'invalid', reason: 'no items' };
  const rows: CustomsRateRow[] = [];
  const seen = new Set<string>();
  for (const it of o.items) {
    const code = typeof it?.code === 'string' ? it.code.trim().toUpperCase() : '';
    if (!/^[A-Z]{3}$/.test(code) || code === 'TWD' || seen.has(code)) continue;
    const buy = pos(it.buyValue);
    const sell = pos(it.sellValue);
    if (!buy && !sell) continue;
    // 買價高過賣價＝資料錯，整筆不要
    if (buy && sell && buy > sell) continue;
    seen.add(code);
    rows.push({ currency: code, buy, sell });
  }
  if (!seen.has('USD')) return { kind: 'invalid', reason: 'no USD row' };
  return { kind: 'rates', period: { start, end }, rows };
}

/**
 * 來源是不是拒絕存取（防機器人驗證頁、WAF 擋、限流）。遇到就停下來，不重試。
 * 判斷：HTTP 401／403／429；或預期 JSON 卻拿到 HTML，且看得出是驗證／擋人頁面。
 */
export function isAccessRefused(status: number, contentType: string | null, body: string): boolean {
  if (status === 401 || status === 403 || status === 429) return true;
  const head = (body ?? '').slice(0, 4096);
  const html = /text\/html/i.test(contentType ?? '') || /^\s*<(!doctype|html)/i.test(head);
  if (!html) return false;
  return /challenge|captcha|sec-cpt|sec_cpt|request rejected|access denied|support id|cf-chl|bot detection|are you a robot|驗證/i.test(head);
}

/** 臺銀舊資料（source='BOT'）的欄位：pickSellRate 用 */
export interface BotRateRow {
  currency: string;
  cashBuy: number | null;
  spotBuy: number | null;
  cashSell: number | null;
  spotSell: number | null;
}

export type FxBasis = 'CUSTOMS_SELL' | 'BOT_SPOT_SELL' | 'BOT_CASH_SELL' | 'ENV' | 'DEFAULT';

/** 臺銀舊資料估算用的單一匯率：即期賣出優先，沒有才用現金賣出。 */
export function pickSellRate(row: Pick<BotRateRow, 'spotSell' | 'cashSell'>): { rate: number; basis: 'BOT_SPOT_SELL' | 'BOT_CASH_SELL' } | null {
  if (row.spotSell && row.spotSell > 0) return { rate: row.spotSell, basis: 'BOT_SPOT_SELL' };
  if (row.cashSell && row.cashSell > 0) return { rate: row.cashSell, basis: 'BOT_CASH_SELL' };
  return null;
}

/** 最後一道退路：固定值（約 2026-11 的臺銀即期賣出，取整）。只在 DB 與 env 都沒有時用。 */
export const DEFAULT_FX_RATES: Record<string, number> = {
  USD: 32.5,
  JPY: 0.21,
  EUR: 35.5,
  CNY: 4.5,
  HKD: 4.15,
  KRW: 0.024,
  GBP: 41.5,
  AUD: 21.5,
  SGD: 24.5,
  THB: 0.95,
};

/** env FX_REFERENCE_RATES='{"USD":32.4}'；格式錯或非正數就當沒設。 */
export function envFxRates(env: NodeJS.ProcessEnv = process.env): Record<string, number> {
  const out: Record<string, number> = {};
  if (!env.FX_REFERENCE_RATES) return out;
  try {
    const o = JSON.parse(env.FX_REFERENCE_RATES) as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k.toUpperCase()] = v;
  } catch {
    /* 格式錯就當沒設 */
  }
  return out;
}

export interface FxQuote {
  currency: string;
  rate: number;
  basis: FxBasis;
  rateDate: string | null; // 臺銀＝牌告日期；關務署＝該旬第一天（YYYY-MM-DD）；env／固定值為 null
}

/** DB 查到的那一筆（消費日所在的旬／當天，或之前最近一筆） */
export interface FxDbRow {
  rateDate: string;
  spotSell: number | null;
  cashSell: number | null;
  source?: string; // 'CUSTOMS'（關務署）｜'BOT'（臺銀舊資料）；沒給當 BOT
}

/** 退回順序：DB（關務署／臺銀舊資料）→ env FX_REFERENCE_RATES → 固定值；都沒有回 null（呼叫端要問幣別）。 */
export function resolveFxQuote(currency: string, dbRow: FxDbRow | null, env: NodeJS.ProcessEnv = process.env): FxQuote | null {
  const cur = currency.toUpperCase();
  if (dbRow) {
    if (dbRow.source === 'CUSTOMS') {
      if (dbRow.spotSell && dbRow.spotSell > 0) return { currency: cur, rate: dbRow.spotSell, basis: 'CUSTOMS_SELL', rateDate: dbRow.rateDate };
    } else {
      const p = pickSellRate(dbRow);
      if (p) return { currency: cur, rate: p.rate, basis: p.basis, rateDate: dbRow.rateDate };
    }
  }
  const e = envFxRates(env)[cur];
  if (e) return { currency: cur, rate: e, basis: 'ENV', rateDate: null };
  const d = DEFAULT_FX_RATES[cur];
  if (d) return { currency: cur, rate: d, basis: 'DEFAULT', rateDate: null };
  return null;
}

/**
 * 原幣 × 匯率 → 台幣，四捨五入到元（.5 進位）。
 * 用整數算（金額到分、匯率到 1e-6）避免浮點把 x.5 算成 x.4999。
 */
export function convertToTwd(amount: number, rate: number): number {
  const a = BigInt(Math.round(amount * 100)); // 分
  const r = BigInt(Math.round(rate * 1_000_000)); // 1e-6
  const scale = 100n * 1_000_000n;
  const p = a * r;
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const q = (abs + scale / 2n) / scale;
  return Number(neg ? -q : q);
}

/** 匯率說明文字（給 LINE 回覆）：「關務署 11月中旬報關匯率 32.93」「臺銀 11/04 即期賣出 32.875」 */
export function fxQuoteLabel(q: Pick<FxQuote, 'rate' | 'basis' | 'rateDate'>): string {
  if (q.basis === 'CUSTOMS_SELL') return `關務署 ${q.rateDate ? tenDayPeriodLabel(q.rateDate) : ''}報關匯率 ${q.rate}`;
  const md = q.rateDate ? `${q.rateDate.slice(5, 7)}/${q.rateDate.slice(8, 10)} ` : '';
  if (q.basis === 'BOT_SPOT_SELL') return `臺銀 ${md}即期賣出 ${q.rate}`;
  if (q.basis === 'BOT_CASH_SELL') return `臺銀 ${md}現金賣出 ${q.rate}`;
  return `參考匯率 ${q.rate}`;
}

// ---- 日期與缺口 ----

/** YYYY-MM-DD 加減天數 */
export function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isWeekendYmd(ymd: string): boolean {
  const w = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return w === 0 || w === 6;
}

/** 消費日往前最多找幾天（再久就退回 env／固定值，避免拿很舊的匯率） */
export const FX_MAX_LOOKBACK_DAYS = 30;

/**
 * 消費日之前找不到時，往後最多看幾天：關務署下一旬的數字在當旬內就公布、取樣也在當旬，
 * 所以「下一旬」比「上上旬」更接近消費日。只在之前完全沒有資料（剛上線、缺期）時用。
 */
export const FX_MAX_LOOKAHEAD_DAYS = 11;

/** 從一組已存的日期，挑出「消費日當天或之前最近一筆」（在回看天數內）。 */
export function nearestRateDate(dates: string[], ymd: string, maxLookbackDays = FX_MAX_LOOKBACK_DAYS): string | null {
  const floor = addDaysYmd(ymd, -maxLookbackDays);
  let best: string | null = null;
  for (const d of dates) if (d <= ymd && d >= floor && (!best || d > best)) best = d;
  return best;
}

/** 已有匯率涵蓋到哪一天：關務署那筆涵蓋整旬（到旬底），臺銀舊資料只涵蓋當天。 */
export function coveredThrough(latest: { rateDate: string; source: string } | null): string | null {
  if (!latest) return null;
  return latest.source === 'CUSTOMS' ? tenDayPeriodOf(latest.rateDate).end : latest.rateDate;
}

/** 涵蓋日之後到今天（含）缺了幾個平日；最多數 lookback 天。完全沒資料就數滿 lookback 內的平日。 */
export function countMissingBusinessDays(covered: string | null, nowYmd: string, lookback = 30): number {
  let n = 0;
  for (let i = 0; i < lookback; i++) {
    const d = addDaysYmd(nowYmd, -i);
    if (covered && d <= covered) break;
    if (!isWeekendYmd(d)) n++;
  }
  return n;
}
