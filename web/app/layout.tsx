import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '家庭共同記帳',
  description: 'LINE 家庭共同記帳 — 文字 / 拍照 / AI 自動分類',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body className="bg-gray-50 text-gray-900">{children}</body>
    </html>
  );
}
