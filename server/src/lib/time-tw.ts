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

// YYYY-MM-DD（台北日期）→ 台北當天中午的 Date（存進 DateTime 欄位，再用 ymdTaipei 讀回同一天）。非法回 undefined。
export function taipeiNoon(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const d = new Date(`${raw}T12:00:00+08:00`);
  return Number.isNaN(d.getTime()) || ymdTaipei(d) !== raw ? undefined : d;
}
