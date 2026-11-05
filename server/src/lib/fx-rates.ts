// 外幣參考匯率（純函式，不碰 DB、不打網路）。
//
// 來源：臺灣銀行牌告匯率（https://rate.bot.com.tw/xrt?Lang=zh-TW，頁面註明「本表資料僅供參考」）。
// 官方下載點（頁面上「下載 Excel (CSV) 檔」）：
//   - 即時：  https://rate.bot.com.tw/xrt/flcsv/0/day        （非營業時間會換成「非營業時間牌告」，晚上也會變）
//   - 指定日：https://rate.bot.com.tw/xrt/flcsv/0/YYYY-MM-DD （＝歷史匯率「收盤價」那一頁，11-04 掛牌時間 16:01）
//   假日／無資料的日期回「很抱歉，本次查詢找不到任何一筆資料！」（不是 CSV）。
// 我們只抓「指定日」那份：每天的數字固定（收盤價），重抓同一天結果一樣，開機補抓也用它。
//
// CSV 格式（2026-11-05 查證）：UTF-8 帶 BOM，每列 22 欄、列尾多一個逗號：
//   0 幣別 | 1「本行買入」| 2 現金買入 | 3 即期買入 | 4～10 遠期買入（10/30/60/90/120/150/180 天）
//   11「本行賣出」| 12 現金賣出 | 13 即期賣出 | 14～20 遠期賣出 | 21 空
//   數字是「1 單位外幣＝多少台幣」，沒有報價填 0（例如 ZAR 沒有現金、IDR 沒有即期）。
//   共 19 幣：USD HKD GBP AUD CAD SGD CHF JPY ZAR SEK NZD THB PHP IDR EUR KRW VND MYR CNY。
//
// 用哪一種價：信用卡外幣消費＝銀行替你「賣」外幣給收單端，最接近的公開數字是「即期賣出」；
// 現金賣出含現鈔運送成本、偏高，只在該幣沒有即期報價時才用（IDR、VND 這類）。
// 卡組織實際匯率與海外手續費（約 1.5%）不在這裡算 → 一律標 amountEstimated，卡帳單進來後改實際扣款金額。

export interface BotRateRow {
  currency: string;
  cashBuy: number | null;
  spotBuy: number | null;
  cashSell: number | null;
  spotSell: number | null;
}

export type BotCsvResult =
  | { kind: 'rates'; rows: BotRateRow[] }
  | { kind: 'no_data' } // 假日／當天沒有牌告
  | { kind: 'invalid'; reason: string }; // 不是預期的 CSV（例如防機器人挑戰頁、改版）

const pos = (v: string | undefined): number | null => {
  const n = Number((v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** 解析臺銀牌告 CSV。不是 CSV（挑戰頁、錯誤頁）回 invalid，查無資料回 no_data。 */
export function parseBotCsv(text: string): BotCsvResult {
  const body = (text ?? '').replace(/^﻿/, '').trim();
  if (!body) return { kind: 'invalid', reason: 'empty body' };
  if (/找不到任何一筆資料/.test(body)) return { kind: 'no_data' };
  const lines = body.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(',').map((x) => x.trim());
  if (header[0] !== '幣別' || header[2] !== '現金' || header[3] !== '即期' || header[12] !== '現金' || header[13] !== '即期') {
    return { kind: 'invalid', reason: `unexpected header: ${lines[0].slice(0, 60)}` };
  }
  const rows: BotRateRow[] = [];
  for (const line of lines.slice(1)) {
    const f = line.split(',').map((x) => x.trim());
    if (f.length < 14 || !/^[A-Z]{3}$/.test(f[0]) || f[1] !== '本行買入' || f[11] !== '本行賣出') continue;
    rows.push({ currency: f[0], cashBuy: pos(f[2]), spotBuy: pos(f[3]), cashSell: pos(f[12]), spotSell: pos(f[13]) });
  }
  if (!rows.length) return { kind: 'invalid', reason: 'no rate rows' };
  return { kind: 'rates', rows };
}

export type FxBasis = 'BOT_SPOT_SELL' | 'BOT_CASH_SELL' | 'ENV' | 'DEFAULT';

/** 估算用的單一匯率：即期賣出優先，沒有才用現金賣出。 */
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
  rateDate: string | null; // 牌告日期（YYYY-MM-DD）；env／固定值為 null
}

/** DB 查到的那一筆（消費日當天或之前最近一個營業日） */
export interface FxDbRow {
  rateDate: string;
  spotSell: number | null;
  cashSell: number | null;
}

/** 退回順序：臺銀（DB）→ env FX_REFERENCE_RATES → 固定值；都沒有回 null（呼叫端要問幣別）。 */
export function resolveFxQuote(currency: string, dbRow: FxDbRow | null, env: NodeJS.ProcessEnv = process.env): FxQuote | null {
  const cur = currency.toUpperCase();
  if (dbRow) {
    const p = pickSellRate(dbRow);
    if (p) return { currency: cur, rate: p.rate, basis: p.basis, rateDate: dbRow.rateDate };
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

/** 匯率說明文字（給 LINE 回覆）：「臺銀 11/04 即期賣出 32.875」 */
export function fxQuoteLabel(q: Pick<FxQuote, 'rate' | 'basis' | 'rateDate'>): string {
  const md = q.rateDate ? `${q.rateDate.slice(5, 7)}/${q.rateDate.slice(8, 10)} ` : '';
  if (q.basis === 'BOT_SPOT_SELL') return `臺銀 ${md}即期賣出 ${q.rate}`;
  if (q.basis === 'BOT_CASH_SELL') return `臺銀 ${md}現金賣出 ${q.rate}`;
  return `參考匯率 ${q.rate}`;
}

// ---- 營業日（臺銀週六日不掛牌；國定假日由「查無資料」得知）----

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

/** 消費日往前最多找幾天（春節連假約 9 天；再久就退回 env／固定值，避免拿很舊的匯率） */
export const FX_MAX_LOOKBACK_DAYS = 30;

/** 從一組已存的牌告日期，挑出「消費日當天或之前最近一筆」（在回看天數內）。 */
export function nearestRateDate(dates: string[], ymd: string, maxLookbackDays = FX_MAX_LOOKBACK_DAYS): string | null {
  const floor = addDaysYmd(ymd, -maxLookbackDays);
  let best: string | null = null;
  for (const d of dates) if (d <= ymd && d >= floor && (!best || d > best)) best = d;
  return best;
}

/**
 * 要補抓哪些日期：最近 days 天內的平日、還沒存過的；今天要過了收盤後抓取時間（台北 16:30）才算。
 * nowTaipeiYmd／nowTaipeiMinutes 由呼叫端用台北時間算好。
 */
export function datesToBackfill(have: Set<string>, nowTaipeiYmd: string, nowTaipeiMinutes: number, days = 7, readyMinutes = 16 * 60 + 30): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDaysYmd(nowTaipeiYmd, -i);
    if (isWeekendYmd(d) || have.has(d)) continue;
    if (i === 0 && nowTaipeiMinutes < readyMinutes) continue;
    out.push(d);
  }
  return out;
}
