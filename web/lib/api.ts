const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

export async function apiGet<T>(path: string, lineUserId: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'x-line-user-id': lineUserId },
  });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiPut<T>(path: string, lineUserId: string, body: unknown): Promise<T> {
  return apiSend<T>('PUT', path, lineUserId, body);
}

export async function apiPost<T>(path: string, lineUserId: string, body: unknown): Promise<T> {
  return apiSend<T>('POST', path, lineUserId, body);
}

export async function apiPatch<T>(path: string, lineUserId: string, body: unknown): Promise<T> {
  return apiSend<T>('PATCH', path, lineUserId, body);
}

async function apiSend<T>(method: string, path: string, lineUserId: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'x-line-user-id': lineUserId, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

// CSV 匯出需帶 header，無法用 <a href> 直接下載，改 fetch blob 觸發下載
export async function apiDownload(path: string, lineUserId: string, filename: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'x-line-user-id': lineUserId },
  });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
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
