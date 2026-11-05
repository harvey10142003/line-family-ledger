// P0-4 結構守門（不需要資料庫）：
// 1. 稽核表只加不改：程式裡不能有 auditLog 的 update／delete／upsert，也不能有改刪 "AuditLog" 的 SQL。
// 2. 刪交易、改交易（LIFF 與 LINE 快速修正）一定跟稽核寫在同一個 $transaction 裡。
// 3. detail 禁用欄位（備註、姓名、密碼…）直接丟錯。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

test('稽核表只加不改：沒有 auditLog.update／delete／upsert，也沒有改刪 AuditLog 的 SQL', () => {
  const bad: string[] = [];
  for (const f of walk(SRC)) {
    // 註解裡的說明文字不算
    const code = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    if (/auditLog\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\s*\(/.test(code)) bad.push(`${relative(SRC, f)}: prisma auditLog mutation`);
    if (/(UPDATE|DELETE\s+FROM|TRUNCATE)\s+"?AuditLog"?/i.test(code)) bad.push(`${relative(SRC, f)}: raw SQL on AuditLog`);
  }
  assert.deepEqual(bad, []);
});

test('改、刪交易都跟稽核同一個交易（LIFF 路由與 LINE 快速修正）', () => {
  for (const rel of [join('routes', 'liff.ts'), join('line', 'handlers', 'quick-fix.ts')]) {
    const lines = readFileSync(join(SRC, rel), 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      if (!/prisma\.transaction\.(update|delete)\(/.test(l)) return;
      const window = lines.slice(Math.max(0, i - 3), i + 14).join('\n');
      assert.match(window, /\$transaction\(\[/, `${rel}:${i + 1} 要包在 $transaction 裡`);
      assert.match(window, /auditCreateOp\(/, `${rel}:${i + 1} 要一起寫稽核`);
    });
  }
});

test('detail 不能放備註、姓名、密碼這類欄位；字串截短', async () => {
  process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/none';
  const { sanitizeDetail, AuditDetailError } = await import('../src/services/audit');
  for (const k of ['note', 'legalName', 'password', 'displayName', 'text', 'email']) {
    assert.throws(() => sanitizeDetail({ [k]: 'x' }), AuditDetailError, k);
  }
  const out = sanitizeDetail({ fields: ['note', 'amount'], month: '2026-10', long: 'x'.repeat(200) }) as Record<string, unknown>;
  assert.deepEqual(out.fields, ['note', 'amount'], '欄位「名稱」可以列');
  assert.equal((out.long as string).length, 80);
});

test('pickSubject：優先記「別人」的；都是自己的回自己；全共同回 null', async () => {
  const { pickSubject } = await import('../src/services/audit');
  assert.equal(pickSubject([null, 'm_apple'], 'm_shark'), 'm_apple');
  assert.equal(pickSubject(['m_shark', 'm_apple'], 'm_shark'), 'm_apple');
  assert.equal(pickSubject(['m_shark'], 'm_shark'), 'm_shark');
  assert.equal(pickSubject([null, undefined], 'm_shark'), null);
});
