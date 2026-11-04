// 台北時區（UTC+8，無日光節約）日期工具。
// 不依賴主機 TZ：先 +8 小時，再用 getUTC* 取年月日。

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

// 把某個時間點轉成台北當地的 YYYY-MM-DD
export function ymdTaipei(d: Date): string {
  const t = new Date(d.getTime() + TAIPEI_OFFSET_MS);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const day = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
