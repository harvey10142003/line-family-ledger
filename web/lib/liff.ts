import liff from '@line/liff';

let initialized = false;

export async function initLiff(): Promise<void> {
  if (initialized) return;
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
  if (!liffId) throw new Error('Missing NEXT_PUBLIC_LIFF_ID');
  await liff.init({ liffId });
  initialized = true;
}

export async function getProfile() {
  if (!liff.isLoggedIn()) {
    liff.login();
    return null;
  }
  return liff.getProfile();
}

// 同一分頁 60 秒內只自動重登一次，避免 token 一直無效時無限跳轉
const RELOGIN_KEY = 'ledger_liff_relogin_at';
const RELOGIN_WINDOW_MS = 60_000;

export class LiffSessionExpiredError extends Error {
  constructor() {
    super('登入資訊已過期，請關閉記帳簿後從 LINE 重新開啟');
    this.name = 'LiffSessionExpiredError';
  }
}

/**
 * 重新取得登入（ID token 過期 / 失效時用）。
 * - LIFF Browser 內官方禁止手動 liff.login()：logout 後 reload，讓 liff.init 自動重登。
 * - 外部瀏覽器：logout 後 liff.login()（不帶 redirectUri＝回 LIFF endpoint 根，避開 redirect 白名單坑）。
 * 回傳 true＝已觸發跳轉；false＝60 秒內已試過，交給呼叫端顯示錯誤。
 */
export function reloginOnce(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const last = Number(window.sessionStorage.getItem(RELOGIN_KEY) || 0);
    if (Date.now() - last < RELOGIN_WINDOW_MS) return false;
    window.sessionStorage.setItem(RELOGIN_KEY, String(Date.now()));
  } catch {
    // sessionStorage 不可用時仍嘗試一次
  }
  try {
    liff.logout();
  } catch {
    // 尚未登入也無妨
  }
  if (liff.isInClient()) window.location.reload();
  else liff.login();
  return true;
}

/**
 * 取目前可用的 LIFF ID token；快過期（10 秒內）或拿不到就觸發重登並丟錯。
 * 拿不到通常代表 LIFF app 的 scope 沒勾 openid。
 */
export function getValidIdToken(): string {
  const token = liff.getIDToken();
  const decoded = liff.getDecodedIDToken();
  const expMs = decoded?.exp ? decoded.exp * 1000 : 0;
  if (!token || !expMs || expMs - Date.now() < 10_000) {
    reloginOnce();
    throw new LiffSessionExpiredError();
  }
  return token;
}

export { liff };
