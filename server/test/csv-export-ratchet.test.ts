// CSV／Excel 匯出棘輪（11-06 fix/ledger-csv-formula-injection，對齊 CRM csv-export-formula-guard-ratchet）：
// 產生 CSV 的地方一律走 server/src/lib/csv.ts（csvCell／csvNumberCell／csvRow），不准自己手寫跳脫或自己判斷公式開頭。
// 前端不准在瀏覽器自組 CSV（text/csv Blob、data:text/csv）：匯出都由 server 產，前端只把 server 回的檔案原樣下載。
// 新增匯出點時：server 端 import lib/csv；確定不是產 CSV 的（例如抓臺銀 CSV 的 Accept 標頭）才加進例外清單並寫原因。不需要資料庫。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SERVER_SRC = join(ROOT, 'server', 'src');
const WEB = join(ROOT, 'web');
const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'dist']);
const EXT = /\.(tsx?|jsx?)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

const rel = (f: string) => relative(ROOT, f).split(sep).join('/');
const serverFiles = walk(SERVER_SRC);
const webFiles = walk(WEB);

// 例外：不是在「產生」CSV
const SERVER_ALLOW = new Map<string, string>([
  ['server/src/lib/csv.ts', '唯一出口本身'],
  ['server/src/services/fx.ts', '抓臺銀牌告 CSV（Accept: text/csv），是讀檔不是匯出'],
  ['server/src/lib/fx-rates.ts', '解析臺銀牌告 CSV，是讀檔不是匯出'],
]);

test('掃得到檔案（防路徑寫錯變成空掃描）', () => {
  assert.ok(serverFiles.some((f) => rel(f) === 'server/src/routes/liff.ts'));
  assert.ok(webFiles.some((f) => rel(f) === 'web/lib/api.ts'));
});

test('server：回 text/csv 或組 CSV 的檔案都要 import lib/csv', () => {
  const hits: string[] = [];
  for (const f of serverFiles) {
    const r = rel(f);
    if (SERVER_ALLOW.has(r)) continue;
    const src = readFileSync(f, 'utf8');
    const producesCsv = /text\/csv|\.csv["'`]|ms-excel|spreadsheetml/i.test(src);
    if (producesCsv && !/from ['"](\.\.?\/)+(lib\/)?csv['"]/.test(src)) hits.push(r);
  }
  assert.deepEqual(hits, [], `這些檔案產 CSV 但沒走 lib/csv.ts：\n${hits.join('\n')}`);
});

test('server：lib/csv.ts 以外不准手寫 CSV 跳脫或公式開頭判斷', () => {
  const hits: string[] = [];
  for (const f of serverFiles) {
    const r = rel(f);
    if (r === 'server/src/lib/csv.ts') continue;
    readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        // .replace(/"/g, '""') 這類自己跳脫；/^[=+\-@...] 這類自己寫公式 regex
        if (/replace\(\s*\/"\/g\s*,\s*['"`]""['"`]/.test(line) || /\[=\+\\?-@/.test(line)) hits.push(`${r}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
  assert.deepEqual(hits, [], hits.join('\n'));
});

test('web：不准在瀏覽器自組 CSV／Excel（匯出由 server 產）', () => {
  const hits: string[] = [];
  for (const f of webFiles) {
    readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (/text\/csv|data:text\/csv|ms-excel|spreadsheetml|from ['"]xlsx['"]|require\(['"]xlsx['"]\)/i.test(line)) hits.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
  assert.deepEqual(hits, [], hits.join('\n'));
});
