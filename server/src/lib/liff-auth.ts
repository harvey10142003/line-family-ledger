// LIFF 身分驗證 middleware。
//
// 為什麼：/api/liff/* 以前只讀 header `x-line-user-id` 就當本人，拿到任何成員的
// LINE userId（例如從 webhook log、截圖）就能讀寫整個家庭帳。改成前端送
// `Authorization: Bearer <liff.getIDToken()>`，後端打 LINE 官方 verify 端點驗簽、
// 比對 aud＝本 LIFF 所屬 LINE Login channel id，取 sub 當 userId。
//
// 規則：
// - 不接受 x-line-user-id（沒有 header 後門，連 dev 也沒有）。
// - LINE verify 問不到（網路 / 5xx）一律 503 擋下（fail-closed），不放行。
// - 驗證結果以 token 的 sha256 為 key 短暫快取，存活不超過 token 的 exp。
import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const LINE_ID_TOKEN_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';

export type LiffAuthErrorCode = 'missing_token' | 'token_expired' | 'invalid_token' | 'verify_unavailable';

export type VerifyResult =
  | { ok: true; sub: string; expMs: number }
  | { ok: false; code: Exclude<LiffAuthErrorCode, 'missing_token'>; detail?: string };

export interface LiffAuthOptions {
  /** 本 LIFF 所屬的 LINE Login channel id（ID token 的 aud）。 */
  channelId: string;
  /** 可替換的 fetch（測試用）。 */
  fetchImpl?: typeof fetch;
  /** 可替換的時鐘（測試用）。 */
  now?: () => number;
  /** 快取上限秒數，實際存活取 min(此值, token exp)。 */
  cacheTtlSec?: number;
  /** 快取筆數上限，超過時先清過期、仍超過就整個清空。 */
  cacheMax?: number;
  /** 呼叫 LINE verify 的逾時毫秒。 */
  timeoutMs?: number;
  onVerifyError?: (err: unknown) => void;
}

/** 從 res.locals 取已驗證的 LINE userId（只有 liffAuth 之後的 handler 能用）。 */
export function authedLineUserId(res: Response): string {
  const v = res.locals.lineUserId;
  if (typeof v !== 'string' || !v) {
    // 路由沒掛 middleware 就呼叫 → 程式錯誤，寧可 500 也不要當匿名繼續
    throw new Error('authedLineUserId called without liffAuth middleware');
  }
  return v;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function extractBearer(req: Request): string | null {
  const h = req.header('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  const t = m?.[1]?.trim();
  return t ? t : null;
}

/** 打 LINE 官方 ID token verify 端點。 */
export async function verifyIdTokenWithLine(
  idToken: string,
  channelId: string,
  opts: { fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
): Promise<VerifyResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const body = new URLSearchParams({ id_token: idToken, client_id: channelId });

  let r: globalThis.Response;
  try {
    r = await fetchImpl(LINE_ID_TOKEN_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
  } catch (err) {
    return { ok: false, code: 'verify_unavailable', detail: String((err as Error)?.message ?? err) };
  }

  if (r.status >= 500) return { ok: false, code: 'verify_unavailable', detail: `LINE verify ${r.status}` };

  let json: any = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }

  if (r.status !== 200) {
    // LINE 對過期回 400 {"error":"invalid_request","error_description":"IdToken expired."}
    const desc = String(json?.error_description ?? '');
    if (/expired/i.test(desc)) return { ok: false, code: 'token_expired', detail: desc };
    return { ok: false, code: 'invalid_token', detail: desc || `LINE verify ${r.status}` };
  }

  const sub = typeof json?.sub === 'string' ? json.sub : '';
  const aud = json?.aud;
  const expSec = Number(json?.exp);
  // LINE 已用 client_id 驗過 aud，這裡再自己核一次，不信任單一層
  const audOk = Array.isArray(aud) ? aud.includes(channelId) : aud === channelId;
  if (!sub || !audOk || !Number.isFinite(expSec)) {
    return { ok: false, code: 'invalid_token', detail: 'verify response missing sub/aud/exp or aud mismatch' };
  }
  const expMs = expSec * 1000;
  if (expMs <= now()) return { ok: false, code: 'token_expired', detail: 'exp in the past' };
  return { ok: true, sub, expMs };
}

const MESSAGES: Record<LiffAuthErrorCode, string> = {
  missing_token: 'missing Authorization bearer id token',
  token_expired: 'id token expired',
  invalid_token: 'invalid id token',
  verify_unavailable: 'LINE verify unavailable',
};

export function createLiffAuth(options: LiffAuthOptions) {
  const channelId = String(options.channelId ?? '').trim();
  if (!channelId) throw new Error('createLiffAuth: channelId is required');
  const now = options.now ?? Date.now;
  const ttlMs = (options.cacheTtlSec ?? 300) * 1000;
  const cacheMax = options.cacheMax ?? 5000;
  const cache = new Map<string, { sub: string; untilMs: number }>();

  function prune(t: number) {
    for (const [k, v] of cache) if (v.untilMs <= t) cache.delete(k);
    if (cache.size >= cacheMax) cache.clear();
  }

  function deny(res: Response, code: LiffAuthErrorCode) {
    const status = code === 'verify_unavailable' ? 503 : 401;
    return res.status(status).json({ error: MESSAGES[code], code });
  }

  const middleware = async (req: Request, res: Response, next: NextFunction) => {
    // 絕不採信舊 header：先清掉 locals，避免任何上游殘留
    delete res.locals.lineUserId;

    const token = extractBearer(req);
    if (!token) return deny(res, 'missing_token');

    const key = hashToken(token);
    const t = now();
    const hit = cache.get(key);
    if (hit && hit.untilMs > t) {
      res.locals.lineUserId = hit.sub;
      return next();
    }
    if (hit) cache.delete(key);

    const result = await verifyIdTokenWithLine(token, channelId, {
      fetchImpl: options.fetchImpl,
      now,
      timeoutMs: options.timeoutMs,
    });
    if (!result.ok) {
      if (result.code === 'verify_unavailable') options.onVerifyError?.(result.detail);
      return deny(res, result.code);
    }

    if (cache.size >= cacheMax) prune(t);
    cache.set(key, { sub: result.sub, untilMs: Math.min(result.expMs, t + ttlMs) });
    res.locals.lineUserId = result.sub;
    return next();
  };

  return Object.assign(middleware, { _cache: cache });
}

/**
 * channel id 解析：優先 LINE_LOGIN_CHANNEL_ID；未設時用 LIFF id 的前綴
 * （LIFF id 格式＝`{loginChannelId}-{suffix}`）。兩者都沒有就丟錯，伺服器起不來。
 */
export function resolveLoginChannelId(env: NodeJS.ProcessEnv): { channelId: string; source: 'env' | 'liff_id_prefix' } {
  const explicit = env.LINE_LOGIN_CHANNEL_ID?.trim();
  if (explicit) return { channelId: explicit, source: 'env' };
  const prefix = env.LINE_LIFF_ID?.trim().split('-')[0];
  if (prefix && /^\d+$/.test(prefix)) return { channelId: prefix, source: 'liff_id_prefix' };
  throw new Error('Missing env: LINE_LOGIN_CHANNEL_ID (and LINE_LIFF_ID prefix not usable)');
}
