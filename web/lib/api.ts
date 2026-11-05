import { getValidIdToken, reloginOnce, LiffSessionExpiredError } from './liff';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

// 身分改由 LIFF ID token（Authorization: Bearer）證明，後端驗簽後取 sub。
// 各函式保留 lineUserId 參數只為了不動呼叫端簽名，不再送出。
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${getValidIdToken()}`, ...(extra ?? {}) };
}

async function request(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (res.status === 401) {
    // token 過期 / 失效 / 缺少 → 重登一次；60 秒內已試過就讓使用者看到錯誤
    reloginOnce();
    throw new LiffSessionExpiredError();
  }
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res;
}

export async function apiGet<T>(path: string, _lineUserId?: string): Promise<T> {
  const res = await request(path, { headers: authHeaders() });
  return res.json() as Promise<T>;
}

export async function apiPut<T>(path: string, _lineUserId: string | undefined, body: unknown): Promise<T> {
  return apiSend<T>('PUT', path, body);
}

export async function apiPost<T>(path: string, _lineUserId: string | undefined, body: unknown): Promise<T> {
  return apiSend<T>('POST', path, body);
}

export async function apiPatch<T>(path: string, _lineUserId: string | undefined, body: unknown): Promise<T> {
  return apiSend<T>('PATCH', path, body);
}

export async function apiDelete<T>(path: string, _lineUserId?: string): Promise<T> {
  const res = await request(path, { method: 'DELETE', headers: authHeaders() });
  return res.json() as Promise<T>;
}

async function apiSend<T>(method: string, path: string, body: unknown): Promise<T> {
  const res = await request(path, {
    method,
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

// CSV 匯出需帶 header，無法用 <a href> 直接下載，改 fetch blob 觸發下載
export async function apiDownload(path: string, _lineUserId: string | undefined, filename: string): Promise<void> {
  const res = await request(path, { headers: authHeaders() });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
