// 介面不放 emoji（D:\AI\CLAUDE.md §7）：掃 web/ 底下所有前端原始碼，出現 emoji 就紅。
// 圖示一律走 web/components/Icon.tsx 的 PATHS。LINE 聊天訊息（server/src/line/）給消費者看，保留 emoji，不在此掃描範圍。
// 另擋「把資料庫 icon 欄位直接印到畫面」：accounts / categories / credit_cards / savings_goals 的 icon 欄位存的是舊的 emoji 預設值，
// 原始碼掃不到，只能從寫法擋（`x.icon ?? ...`、`t.categoryIcon ?? ...` 就是把資料值印出來的寫法）。不需要資料庫。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const WEB = join(__dirname, '..', '..', 'web');
const SKIP_DIRS = new Set(['node_modules', '.next', 'out']);
const EXT = /\.(tsx?|jsx?|css|html)$/;
// Extended_Pictographic 涵蓋 emoji 本體（含 ⬇ 🗓 這類文字型 emoji）；FE0F 是 emoji 變體選擇符。
// 一般箭頭「→」不屬於 Extended_Pictographic，不會誤判。
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

const files = walk(WEB);

test('掃得到 web 的元件（防路徑寫錯變成空掃描）', () => {
  assert.ok(files.some((f) => f.endsWith(join('components', 'AccountsSection.tsx'))));
  assert.ok(files.some((f) => f.endsWith(join('app', 'page.tsx'))));
});

test('web/ 前端原始碼沒有 emoji', () => {
  const hits: string[] = [];
  for (const f of files) {
    readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (EMOJI.test(line)) hits.push(`${relative(WEB, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
  assert.deepEqual(hits, [], `介面不放 emoji，請改用 components/Icon.tsx：\n${hits.join('\n')}`);
});

test('畫面不直接印資料庫的 icon 欄位（裡面是舊的 emoji 預設值）', () => {
  const hits: string[] = [];
  for (const f of files) {
    readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        // icon / categoryIcon / accountIcon … 一律擋
        if (/\.\w*[iI]con\s*\?\?/.test(line)) hits.push(`${relative(WEB, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
  assert.deepEqual(hits, [], `請改成依類型對應 <Icon />：\n${hits.join('\n')}`);
});

test('偵測規則本身：emoji 會中、箭頭與中文不會中', () => {
  for (const s of ['🎉', '💳', '⬇', '🗓', '👨‍👩‍👧']) assert.ok(EMOJI.test(s), s);
  for (const s of ['→', '帳戶合計', '$1,200', '…', '　']) assert.ok(!EMOJI.test(s), s);
});
