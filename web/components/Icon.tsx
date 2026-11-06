// 介面圖示（線條 SVG，跟著文字顏色）。介面不放 emoji：要新圖示加進 PATHS，不要在頁面裡臨時 inline。
import type { ReactNode } from 'react';

const PATHS = {
  // 總覽：長條圖
  overview: (
    <>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M22 20H2" />
    </>
  ),
  // 全貌：走勢折線
  hub: (
    <>
      <path d="M3 3v18h18" />
      <path d="M7 15l4-4 3 3 5-6" />
    </>
  ),
  // 明細：清單
  list: (
    <>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </>
  ),
  // 帳戶：卡片
  card: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
      <path d="M6 15h4" />
    </>
  ),
  // 更多：三個點
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  // 現金：鈔票
  cash: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01" />
      <path d="M18 12h.01" />
    </>
  ),
  // 銀行：建築
  bank: (
    <>
      <path d="M3 21h18" />
      <path d="M3 10h18" />
      <path d="M12 3l9 7H3z" />
      <path d="M5 10v11" />
      <path d="M9.5 10v11" />
      <path d="M14.5 10v11" />
      <path d="M19 10v11" />
    </>
  ),
  // 電子錢包：錢包
  wallet: (
    <>
      <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5" />
      <path d="M16 14h.01" />
    </>
  ),
  // 其他：箱子
  box: (
    <>
      <path d="M21 8l-9-5-9 5v8l9 5 9-5z" />
      <path d="M3 8l9 5 9-5" />
      <path d="M12 13v8" />
    </>
  ),
  // 目標：靶心
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  // 完成／達標：勾
  check: <path d="M20 6L9 17l-5-5" />,
  // 日期：月曆
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
    </>
  ),
  // 匯出：下載
  download: (
    <>
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 21h16" />
    </>
  ),
  // 共同：多人
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2 21v-1a6 6 0 0 1 12 0v1" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7" />
      <path d="M22 21v-1a6 6 0 0 0-4-5.6" />
    </>
  ),
  // 個人：單人
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`inline-block ${className}`}
    >
      {PATHS[name]}
    </svg>
  );
}
