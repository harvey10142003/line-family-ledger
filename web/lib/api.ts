const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

export async function apiGet<T>(path: string, lineUserId: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'x-line-user-id': lineUserId },
  });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}
