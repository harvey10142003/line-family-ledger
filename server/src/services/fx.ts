// 臺銀牌告匯率：每天抓一次存 FxRateDaily，記帳時依消費日換算外幣。
//
// 原則（11-05 Shark 決定）：
// - 抓取失敗不影響記帳：查不到就退回 env FX_REFERENCE_RATES，再退回固定值，交易一律標 amountEstimated＋匯率來源。
// - 不推 LINE：連續缺 2 個營業日以上只寫 error log，/health 的 fx 欄位看得到。
// - 只連 rate.bot.com.tw、逾時 10 秒、不跟隨轉址（轉址＝失敗）。
// 解析與退回順序的規則在 lib/fx-rates.ts（純函式、有單元測試）。
import { prisma } from '../prisma';
import { logger } from '../logger';
import {
  FX_MAX_LOOKBACK_DAYS,
  addDaysYmd,
  convertToTwd,
  datesToBackfill,
  isWeekendYmd,
  parseBotCsv,
  resolveFxQuote,
  type BotRateRow,
  type FxDbRow,
  type FxQuote,
} from '../lib/fx-rates';
import { ymdTaipei } from '../lib/time-tw';
import type { LedgerPlan } from '../lib/ledger-plan';

export const BOT_HOST = 'rate.bot.com.tw';
const BOT_CSV_BASE = `https://${BOT_HOST}/xrt/flcsv/0/`;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;

export type FxFetchResult =
  | { kind: 'rates'; rows: BotRateRow[] }
  | { kind: 'no_data' }
  | { kind: 'error'; reason: string };

/** 抓某一天的臺銀牌告（收盤價）。只連臺銀網域、10 秒逾時、不跟隨轉址。 */
export async function fetchBotRates(ymd: string): Promise<FxFetchResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return { kind: 'error', reason: `bad date ${ymd}` };
  const url = new URL(BOT_CSV_BASE + ymd);
  if (url.protocol !== 'https:' || url.hostname !== BOT_HOST) return { kind: 'error', reason: 'host not allowed' };
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: 'text/csv' } });
    if (res.status >= 300 && res.status < 400) return { kind: 'error', reason: `redirect ${res.status} (not followed)` };
    if (!res.ok) return { kind: 'error', reason: `http ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BODY_BYTES) return { kind: 'error', reason: `body too large ${buf.length}` };
    const text = buf.toString('utf8');
    const parsed = parseBotCsv(text);
    if (parsed.kind === 'rates') return parsed;
    if (parsed.kind === 'no_data') return parsed;
    // 臺銀前面有防機器人機制，偶爾回挑戰頁（HTTP 200 的 HTML）而不是 CSV → 當作失敗，下次再抓
    const challenge = /Challenge Validation|sec-cpt|sec_cpt/i.test(text);
    return { kind: 'error', reason: challenge ? 'bot challenge page (not CSV)' : parsed.reason };
  } catch (err: any) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? `timeout ${FETCH_TIMEOUT_MS}ms` : String(err?.message ?? err);
    return { kind: 'error', reason };
  }
}

const dateOf = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const ymdOfDate = (d: Date) => d.toISOString().slice(0, 10);

/** 存一天的牌告（同一天重抓就覆寫，數字是收盤價、本來就一樣）。即期與現金賣出都沒有的幣別不存。 */
export async function saveRates(ymd: string, rows: BotRateRow[], fetchedAt = new Date()): Promise<number> {
  const keep = rows.filter((r) => r.spotSell || r.cashSell);
  await prisma.$transaction(
    keep.map((r) =>
      prisma.fxRateDaily.upsert({
        where: { currency_rateDate: { currency: r.currency, rateDate: dateOf(ymd) } },
        create: { currency: r.currency, rateDate: dateOf(ymd), spotBuy: r.spotBuy, spotSell: r.spotSell, cashBuy: r.cashBuy, cashSell: r.cashSell, source: 'BOT', fetchedAt },
        update: { spotBuy: r.spotBuy, spotSell: r.spotSell, cashBuy: r.cashBuy, cashSell: r.cashSell, source: 'BOT', fetchedAt },
      }),
    ),
  );
  return keep.length;
}

// ---- 狀態（/health 的 fx 欄位）----
interface FxStatus {
  latestRateDate: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  missingBusinessDays: number; // 最近一筆牌告之後、應該要有卻沒抓到的營業日數（假日／查無資料不算）
}
const status: FxStatus = { latestRateDate: null, lastAttemptAt: null, lastSuccessAt: null, lastError: null, missingBusinessDays: 0 };
const noDataDates = new Set<string>(); // 臺銀回「查無資料」的平日（國定假日），不再重抓
let alertedLevel = 0;

export function fxHealth() {
  return { source: 'BOT', schedule: 'weekdays 16:30 Asia/Taipei + on boot', ...status };
}

/** 測試用：重設記憶體狀態 */
export function resetFxStatusForTest() {
  Object.assign(status, { latestRateDate: null, lastAttemptAt: null, lastSuccessAt: null, lastError: null, missingBusinessDays: 0 });
  noDataDates.clear();
  alertedLevel = 0;
}

function taipeiMinutes(now: Date): number {
  const t = new Date(now.getTime() + 8 * 3600_000);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

/** 算「最近一筆之後缺了幾個營業日」：只數平日、已過 16:30 的今天，扣掉查無資料的日子。 */
function countMissing(latest: string | null, nowYmd: string, nowMin: number, lookback = 14): number {
  let n = 0;
  for (let i = 0; i < lookback; i++) {
    const d = addDaysYmd(nowYmd, -i);
    if (latest && d <= latest) break;
    if (isWeekendYmd(d) || noDataDates.has(d)) continue;
    if (i === 0 && nowMin < 16 * 60 + 30) continue;
    n++;
  }
  return n;
}

let running: Promise<SyncResult> | null = null;
export interface SyncResult {
  saved: { date: string; currencies: number }[];
  noData: string[];
  failed: { date: string; reason: string }[];
}

/**
 * 補抓最近 days 天內還沒存的營業日（排程 16:30 跑、開機跑）。失敗只寫 log，不丟錯。
 * 依序抓、每次間隔 gapMs（不要一次打一串）。同時只跑一個。
 */
export function syncFxRates(opts: { now?: Date; days?: number; fetcher?: (ymd: string) => Promise<FxFetchResult>; gapMs?: number } = {}): Promise<SyncResult> {
  if (running) return running;
  running = doSync(opts).finally(() => {
    running = null;
  });
  return running;
}

async function doSync(opts: { now?: Date; days?: number; fetcher?: (ymd: string) => Promise<FxFetchResult>; gapMs?: number }): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 7;
  const fetcher = opts.fetcher ?? fetchBotRates;
  const gapMs = opts.gapMs ?? 1500;
  const nowYmd = ymdTaipei(now);
  const nowMin = taipeiMinutes(now);
  const result: SyncResult = { saved: [], noData: [], failed: [] };
  try {
    const existing = await prisma.fxRateDaily.findMany({
      where: { rateDate: { gte: dateOf(addDaysYmd(nowYmd, -days)) } },
      select: { rateDate: true },
      distinct: ['rateDate'],
    });
    const have = new Set(existing.map((r) => ymdOfDate(r.rateDate)));
    for (const d of noDataDates) have.add(d);
    const todo = datesToBackfill(have, nowYmd, nowMin, days);
    status.lastAttemptAt = now.toISOString();
    for (let i = 0; i < todo.length; i++) {
      const d = todo[i];
      if (i > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
      const r = await fetcher(d);
      if (r.kind === 'rates') {
        const n = await saveRates(d, r.rows, now);
        result.saved.push({ date: d, currencies: n });
        status.lastSuccessAt = new Date().toISOString();
      } else if (r.kind === 'no_data') {
        noDataDates.add(d);
        result.noData.push(d);
      } else {
        result.failed.push({ date: d, reason: r.reason });
        status.lastError = `${d}: ${r.reason}`;
      }
    }
    if (result.saved.length && !result.failed.length) status.lastError = null;
    await refreshLatest(now);
  } catch (err) {
    status.lastError = `sync: ${String((err as any)?.message ?? err)}`;
    logger.warn({ err }, 'fx sync failed');
  }
  if (result.saved.length) logger.info({ saved: result.saved }, 'fx rates saved (Bank of Taiwan)');
  if (result.failed.length) logger.warn({ failed: result.failed }, 'fx rates fetch failed; bookkeeping falls back to env/default rates');
  if (status.missingBusinessDays >= 2 && status.missingBusinessDays > alertedLevel) {
    alertedLevel = status.missingBusinessDays;
    logger.error({ fx: fxHealth() }, `fx rates missing for ${status.missingBusinessDays} business days (Bank of Taiwan); using fallback rates`);
  }
  if (status.missingBusinessDays < 2) alertedLevel = 0;
  return result;
}

async function refreshLatest(now: Date) {
  const latest = await prisma.fxRateDaily.findFirst({ orderBy: { rateDate: 'desc' }, select: { rateDate: true } });
  status.latestRateDate = latest ? ymdOfDate(latest.rateDate) : null;
  status.missingBusinessDays = countMissing(status.latestRateDate, ymdTaipei(now), taipeiMinutes(now));
}

/** 消費日當天或之前最近一筆（回看 30 天內）；DB 出錯回 null（退回 env／固定值，不擋記帳）。 */
export async function lookupFxRow(currency: string, ymd: string): Promise<FxDbRow | null> {
  try {
    const row = await prisma.fxRateDaily.findFirst({
      where: { currency: currency.toUpperCase(), rateDate: { lte: dateOf(ymd), gte: dateOf(addDaysYmd(ymd, -FX_MAX_LOOKBACK_DAYS)) } },
      orderBy: { rateDate: 'desc' },
    });
    if (!row) return null;
    return {
      rateDate: ymdOfDate(row.rateDate),
      spotSell: row.spotSell == null ? null : Number(row.spotSell),
      cashSell: row.cashSell == null ? null : Number(row.cashSell),
    };
  } catch (err) {
    logger.warn({ err, currency, ymd }, 'fx lookup failed; using fallback rate');
    return null;
  }
}

/** 某幣別在某消費日的參考匯率：臺銀 → env → 固定值。 */
export async function quoteFx(currency: string, ymd: string, env: NodeJS.ProcessEnv = process.env): Promise<FxQuote | null> {
  return resolveFxQuote(currency, await lookupFxRow(currency, ymd), env);
}

/** 計畫裡的外幣收支依消費日換成臺銀匯率（計畫階段先用 env／固定值估過，這裡覆寫）。 */
export async function applyFxToPlan(plan: LedgerPlan, env: NodeJS.ProcessEnv = process.env): Promise<LedgerPlan> {
  for (const it of plan.items) {
    if (it.type !== 'TX' || !it.originalCurrency || it.originalAmount == null) continue;
    const q = await quoteFx(it.originalCurrency, it.date.ymd, env);
    if (!q) continue;
    it.amount = convertToTwd(it.originalAmount, q.rate);
    it.amountEstimated = true;
    it.fx = { rate: q.rate, basis: q.basis, rateDate: q.rateDate };
  }
  return plan;
}
