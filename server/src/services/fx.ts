// 外幣參考匯率：每天抓一次關務署「每旬報關匯率」存 FxRateDaily，記帳時依消費日換算外幣。
//
// 原則（11-05 Shark 決定，11-07 換來源後照舊）：
// - 抓取失敗不影響記帳：查不到就退回 env FX_REFERENCE_RATES，再退回固定值，交易一律標 amountEstimated＋匯率來源。
// - 不推 LINE：缺 2 個營業日以上只寫 error log，/health 的 fx 欄位看得到。
// - 只連 portal.sw.nat.gov.tw、逾時 10 秒、不跟隨轉址（轉址＝失敗）。
// - 來源拒絕存取（防機器人驗證頁、403／429）→ 記一筆清楚的 log、冷卻 12 小時不再打，不重試、不繞過。
//
// 11-07 起不再抓臺銀牌告（rate.bot.com.tw 從 GCP 主機只回防機器人驗證頁，且臺銀沒有程式存取用的官方 API）。
// DB 裡之前存的臺銀資料（source='BOT'）照舊可查。來源說明、換算口徑差異見 lib/fx-rates.ts 檔頭。
import { prisma } from '../prisma';
import { logger } from '../logger';
import {
  FX_MAX_LOOKAHEAD_DAYS,
  FX_MAX_LOOKBACK_DAYS,
  addDaysYmd,
  convertToTwd,
  countMissingBusinessDays,
  coveredThrough,
  isAccessRefused,
  parseCustomsJson,
  resolveFxQuote,
  type CustomsRateRow,
  type FxDbRow,
  type FxQuote,
  type TenDayPeriod,
} from '../lib/fx-rates';
import { ymdTaipei } from '../lib/time-tw';
import type { LedgerPlan } from '../lib/ledger-plan';

export const CUSTOMS_HOST = 'portal.sw.nat.gov.tw';
export const CUSTOMS_JSON_URL = `https://${CUSTOMS_HOST}/APGQ/GC331!downLoad?formBean.downLoadFile=CURRENT_JSON`;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;
/** 來源拒絕存取後多久內不再打 */
export const FX_REFUSED_COOLDOWN_MS = 12 * 3600_000;
// 據實表明身分（不偽裝瀏覽器）
const USER_AGENT = 'family-ledger-fx/1.0 (+https://money.ugomk.com)';

export type FxFetchResult =
  | { kind: 'rates'; period: TenDayPeriod; rows: CustomsRateRow[] }
  | { kind: 'refused'; reason: string } // 來源拒絕存取：不重試
  | { kind: 'error'; reason: string };

/** 抓關務署當期報關匯率。只連關務署網域、10 秒逾時、不跟隨轉址。 */
export async function fetchCustomsRates(): Promise<FxFetchResult> {
  const url = new URL(CUSTOMS_JSON_URL);
  if (url.protocol !== 'https:' || url.hostname !== CUSTOMS_HOST) return { kind: 'error', reason: 'host not allowed' };
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    if (res.status >= 300 && res.status < 400) return { kind: 'error', reason: `redirect ${res.status} (not followed)` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BODY_BYTES) return { kind: 'error', reason: `body too large ${buf.length}` };
    const text = buf.toString('utf8');
    if (isAccessRefused(res.status, res.headers.get('content-type'), text)) {
      return { kind: 'refused', reason: `source refused access (http ${res.status}${res.ok ? ', challenge/block page' : ''})` };
    }
    if (!res.ok) return { kind: 'error', reason: `http ${res.status}` };
    const parsed = parseCustomsJson(text);
    if (parsed.kind === 'rates') return parsed;
    return { kind: 'error', reason: parsed.reason };
  } catch (err: any) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? `timeout ${FETCH_TIMEOUT_MS}ms` : String(err?.message ?? err);
    return { kind: 'error', reason };
  }
}

const dateOf = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const ymdOfDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * 存一旬的報關匯率：每幣一列，rateDate＝該旬第一天，source='CUSTOMS'，買→spotBuy、賣→spotSell（沒有現金價）。
 * 同一旬重抓就覆寫。
 */
export async function saveCustomsRates(period: TenDayPeriod, rows: CustomsRateRow[], fetchedAt = new Date()): Promise<number> {
  const keep = rows.filter((r) => r.sell);
  const rateDate = dateOf(period.start);
  await prisma.$transaction(
    keep.map((r) =>
      prisma.fxRateDaily.upsert({
        where: { currency_rateDate: { currency: r.currency, rateDate } },
        create: { currency: r.currency, rateDate, spotBuy: r.buy, spotSell: r.sell, cashBuy: null, cashSell: null, source: 'CUSTOMS', fetchedAt },
        update: { spotBuy: r.buy, spotSell: r.sell, cashBuy: null, cashSell: null, source: 'CUSTOMS', fetchedAt },
      }),
    ),
  );
  return keep.length;
}

// ---- 狀態（/health 的 fx 欄位）----
interface FxStatus {
  latestRateDate: string | null; // 最新一筆的日期（關務署＝該旬第一天）
  coveredThrough: string | null; // 匯率涵蓋到哪天（關務署＝旬底）
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  refusedUntil: string | null; // 來源拒絕存取後的冷卻期限；期限內不再打
  missingBusinessDays: number; // 涵蓋日之後到今天、沒有匯率的平日數
}
const status: FxStatus = {
  latestRateDate: null,
  coveredThrough: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  refusedUntil: null,
  missingBusinessDays: 0,
};
let alertedLevel = 0;

export function fxHealth() {
  return { source: 'CUSTOMS', schedule: 'daily 16:30 Asia/Taipei + on boot', ...status };
}

/** 測試用：重設記憶體狀態 */
export function resetFxStatusForTest() {
  Object.assign(status, {
    latestRateDate: null,
    coveredThrough: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    refusedUntil: null,
    missingBusinessDays: 0,
  });
  alertedLevel = 0;
}

let running: Promise<SyncResult> | null = null;
export interface SyncResult {
  saved: { periodStart: string; periodEnd: string; currencies: number } | null;
  failed: string | null; // 失敗原因
  refused: boolean; // 來源拒絕存取（本次或冷卻中）
  skipped: string | null; // 冷卻中沒打
}

/**
 * 抓當期報關匯率（排程每天 16:30、開機各一次）。一次只發一個請求、失敗不重試，只寫 log，不丟錯。同時只跑一個。
 */
export function syncFxRates(opts: { now?: Date; fetcher?: () => Promise<FxFetchResult> } = {}): Promise<SyncResult> {
  if (running) return running;
  running = doSync(opts).finally(() => {
    running = null;
  });
  return running;
}

async function doSync(opts: { now?: Date; fetcher?: () => Promise<FxFetchResult> }): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const fetcher = opts.fetcher ?? fetchCustomsRates;
  const result: SyncResult = { saved: null, failed: null, refused: false, skipped: null };
  try {
    if (status.refusedUntil && now.getTime() < Date.parse(status.refusedUntil)) {
      result.refused = true;
      result.skipped = `source refused access earlier; not retrying until ${status.refusedUntil}`;
    } else {
      status.lastAttemptAt = now.toISOString();
      const r = await fetcher();
      if (r.kind === 'rates') {
        const n = await saveCustomsRates(r.period, r.rows, now);
        result.saved = { periodStart: r.period.start, periodEnd: r.period.end, currencies: n };
        status.lastSuccessAt = new Date().toISOString();
        status.lastError = null;
        status.refusedUntil = null;
      } else if (r.kind === 'refused') {
        result.refused = true;
        result.failed = r.reason;
        status.lastError = `${CUSTOMS_HOST}: ${r.reason}`;
        status.refusedUntil = new Date(now.getTime() + FX_REFUSED_COOLDOWN_MS).toISOString();
      } else {
        result.failed = r.reason;
        status.lastError = `${CUSTOMS_HOST}: ${r.reason}`;
      }
    }
    await refreshLatest(now);
  } catch (err) {
    status.lastError = `sync: ${String((err as any)?.message ?? err)}`;
    logger.warn({ err }, 'fx sync failed');
  }
  if (result.saved) logger.info({ saved: result.saved }, 'fx rates saved (Customs Administration ten-day rates)');
  if (result.refused && !result.skipped) {
    logger.warn(
      { host: CUSTOMS_HOST, reason: result.failed, refusedUntil: status.refusedUntil },
      `fx source refused access (來源拒絕存取): ${CUSTOMS_HOST}; not retrying until ${status.refusedUntil}; bookkeeping falls back to stored/env/default rates`,
    );
  } else if (result.failed) {
    logger.warn({ host: CUSTOMS_HOST, reason: result.failed }, 'fx rates fetch failed; bookkeeping falls back to stored/env/default rates');
  }
  if (status.missingBusinessDays >= 2 && status.missingBusinessDays > alertedLevel) {
    alertedLevel = status.missingBusinessDays;
    logger.error({ fx: fxHealth() }, `fx rates missing for ${status.missingBusinessDays} business days (Customs ten-day rates); using fallback rates`);
  }
  if (status.missingBusinessDays < 2) alertedLevel = 0;
  return result;
}

async function refreshLatest(now: Date) {
  const latest = await prisma.fxRateDaily.findFirst({ orderBy: { rateDate: 'desc' }, select: { rateDate: true, source: true } });
  status.latestRateDate = latest ? ymdOfDate(latest.rateDate) : null;
  status.coveredThrough = coveredThrough(latest ? { rateDate: ymdOfDate(latest.rateDate), source: latest.source } : null);
  status.missingBusinessDays = countMissingBusinessDays(status.coveredThrough, ymdTaipei(now));
}

const toDbRow = (row: { rateDate: Date; spotSell: unknown; cashSell: unknown; source: string }): FxDbRow => ({
  rateDate: ymdOfDate(row.rateDate),
  spotSell: row.spotSell == null ? null : Number(row.spotSell),
  cashSell: row.cashSell == null ? null : Number(row.cashSell),
  source: row.source,
});

/**
 * 消費日當天或之前最近一筆（回看 30 天內；關務署那筆的日期是旬首，所以會落在消費日所在的旬）。
 * 之前完全沒有 → 看之後 11 天內有沒有關務署下一旬的數字（當旬內就公布）。DB 出錯回 null（退回 env／固定值，不擋記帳）。
 */
export async function lookupFxRow(currency: string, ymd: string): Promise<FxDbRow | null> {
  const cur = currency.toUpperCase();
  try {
    const row = await prisma.fxRateDaily.findFirst({
      where: { currency: cur, rateDate: { lte: dateOf(ymd), gte: dateOf(addDaysYmd(ymd, -FX_MAX_LOOKBACK_DAYS)) } },
      orderBy: { rateDate: 'desc' },
    });
    if (row) return toDbRow(row);
    const next = await prisma.fxRateDaily.findFirst({
      where: { currency: cur, source: 'CUSTOMS', rateDate: { gt: dateOf(ymd), lte: dateOf(addDaysYmd(ymd, FX_MAX_LOOKAHEAD_DAYS)) } },
      orderBy: { rateDate: 'asc' },
    });
    return next ? toDbRow(next) : null;
  } catch (err) {
    logger.warn({ err, currency, ymd }, 'fx lookup failed; using fallback rate');
    return null;
  }
}

/** 某幣別在某消費日的參考匯率：DB（關務署／臺銀舊資料）→ env → 固定值。 */
export async function quoteFx(currency: string, ymd: string, env: NodeJS.ProcessEnv = process.env): Promise<FxQuote | null> {
  return resolveFxQuote(currency, await lookupFxRow(currency, ymd), env);
}

/** 計畫裡的外幣收支依消費日換成 DB 匯率（計畫階段先用 env／固定值估過，這裡覆寫）。 */
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
