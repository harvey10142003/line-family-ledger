// CSV 匯出的單一格子（MED-2：防公式注入）。規則對齊 CRM apps/api/src/lib/csv/cell.ts：
// - 數字（number）原樣輸出、不加引號：金額在 Excel 要能加總，負數也照常
// - 字串一律加雙引號（內部 " 變 ""）；開頭（含前面已有的單引號）是 = + - @ \t \r 的，前面再加一個 '，
//   Excel／Google 試算表打開就不會當成公式（=HYPERLINK(...) 這類釣魚連結）
// 文字欄（備註、分類、帳戶名）就算長得像負數（"-1"）也一律加 '：它本來就不是要拿來算的數字。
import { ymdTaipei } from './time-tw';

const FORMULA_START =/^'*[=+\-@\t\r]/;

export function csvCell(v: unknown): string {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'bigint') return String(v);
  let s = v == null ? '' : String(v);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

export type LedgerExportRow = {
  paidAt: string | Date;
  type: string;
  categoryName: string;
  accountName?: string | null;
  note?: string | null;
  amount: number;
  memberName: string;
  source: string;
};

/** 記帳簿月明細 CSV（GET /api/liff/export）：Excel 可開，加 UTF-8 BOM 避免中文亂碼。 */
export function ledgerExportCsv(items: LedgerExportRow[]): string {
  const header = ['日期', '類型', '分類', '帳戶', '備註', '金額', '記錄者', '來源'];
  const lines = items.map((t) =>
    csvRow([
      ymdTaipei(new Date(t.paidAt)), // paidAt 是 UTC ISO 字串，要轉台北日期
      t.type === 'INCOME' ? '收入' : '支出',
      t.categoryName,
      t.accountName ?? '',
      t.note ?? '',
      t.amount,
      t.memberName,
      t.source,
    ]),
  );
  return '﻿' + [csvRow(header), ...lines].join('\r\n');
}
