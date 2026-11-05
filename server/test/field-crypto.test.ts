// P0-3：敏感欄位應用層加密（AES-256-GCM）＋金鑰版本與輪替＋fail-closed＋log 遮蔽。不需要資料庫。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import {
  cipherVersion,
  decryptField,
  encryptField,
  FieldCipherError,
  FieldKeyError,
  fieldKeyStatus,
  isFieldCipher,
  loadKeyring,
  needsReencrypt,
  reencryptField,
} from '../src/lib/field-crypto';
import { loggerOptions, REDACT_CENSOR } from '../src/logger';
import { maskLegalName, normalizeLegalName, LegalNameInputError } from '../src/services/legal-name';

const K1 = randomBytes(32).toString('hex');
const K2 = randomBytes(32).toString('base64');
const ENV1 = { LEDGER_FIELD_KEY: K1 };
const CTX = { purpose: 'member.legalName' as const, recordId: 'm_shark' };
const NAME = '施允瀚';

test('加解密來回一致；密文不含明文、每次 IV 不同、格式帶版本', () => {
  const a = encryptField(NAME, CTX, ENV1);
  const b = encryptField(NAME, CTX, ENV1);
  assert.notEqual(a, b, '同一個明文兩次密文要不同（隨機 IV）');
  assert.ok(isFieldCipher(a));
  assert.equal(cipherVersion(a), 1);
  assert.ok(!a.includes(NAME) && !a.includes(Buffer.from(NAME).toString('base64')));
  assert.equal(decryptField(a, CTX, ENV1), NAME);
});

test('AAD 綁那一列：A 成員的密文搬到 B 成員那列解不開', () => {
  const a = encryptField(NAME, CTX, ENV1);
  assert.throws(() => decryptField(a, { ...CTX, recordId: 'm_apple' }, ENV1), FieldCipherError);
});

test('用途分開：真實姓名的密文不能當成文件密碼解', () => {
  const a = encryptField(NAME, CTX, ENV1);
  assert.throws(() => decryptField(a, { purpose: 'document.password', recordId: CTX.recordId }, ENV1), FieldCipherError);
});

test('竄改任一段都解不開', () => {
  const a = encryptField(NAME, CTX, ENV1);
  const parts = a.split(':');
  for (const i of [2, 3, 4]) {
    const p = [...parts];
    const buf = Buffer.from(p[i], 'base64url');
    buf[0] ^= 1;
    p[i] = buf.toString('base64url');
    assert.throws(() => decryptField(p.join(':'), CTX, ENV1), FieldCipherError, `segment ${i}`);
  }
  assert.throws(() => decryptField('plain text', CTX, ENV1), FieldCipherError);
});

test('fail-closed：金鑰沒設、長度不對、版本格式錯 → FieldKeyError，不產生任何密文', () => {
  assert.throws(() => encryptField(NAME, CTX, {}), FieldKeyError);
  assert.throws(() => encryptField(NAME, CTX, { LEDGER_FIELD_KEY: '   ' }), FieldKeyError);
  assert.throws(() => encryptField(NAME, CTX, { LEDGER_FIELD_KEY: 'abcd' }), FieldKeyError);
  assert.throws(() => encryptField(NAME, CTX, { LEDGER_FIELD_KEY: K1, LEDGER_FIELD_KEY_VERSION: '0' }), FieldKeyError);
  assert.throws(() => encryptField(NAME, CTX, { LEDGER_FIELD_KEY: K1, LEDGER_FIELD_KEYS_OLD: 'oops' }), FieldKeyError);
  const st = fieldKeyStatus({});
  assert.equal(st.ok, false);
  // 錯誤訊息不能帶金鑰
  try {
    loadKeyring({ LEDGER_FIELD_KEY: K1.slice(0, 40) });
  } catch (err) {
    assert.ok(!(err as Error).message.includes(K1.slice(0, 40)));
  }
});

test('金鑰輪替：舊密文用舊鑰解、新寫入用新版本；reencrypt 後只要新鑰就能解；舊鑰拿掉前還沒換的會解不開', () => {
  const old = encryptField(NAME, CTX, ENV1);
  const ENV2 = { LEDGER_FIELD_KEY: K2, LEDGER_FIELD_KEY_VERSION: '2', LEDGER_FIELD_KEYS_OLD: `1:${K1}` };
  assert.deepEqual(fieldKeyStatus(ENV2), { ok: true, version: 2, versions: [1, 2] });
  assert.equal(decryptField(old, CTX, ENV2), NAME, '輪替期間舊密文仍可解');
  assert.equal(needsReencrypt(old, ENV2), true);
  const fresh = encryptField(NAME, CTX, ENV2);
  assert.equal(cipherVersion(fresh), 2);
  const rotated = reencryptField(old, CTX, ENV2);
  assert.equal(cipherVersion(rotated), 2);
  assert.equal(needsReencrypt(rotated, ENV2), false);
  assert.equal(reencryptField(rotated, CTX, ENV2), rotated, '已是目前版本原樣回傳');
  const ENV2only = { LEDGER_FIELD_KEY: K2, LEDGER_FIELD_KEY_VERSION: '2' };
  assert.equal(decryptField(rotated, CTX, ENV2only), NAME);
  assert.throws(() => decryptField(old, CTX, ENV2only), FieldKeyError, '舊鑰拿掉後，沒換的舊密文要明確失敗');
  assert.throws(() => loadKeyring({ ...ENV2, LEDGER_FIELD_KEYS_OLD: `2:${K1}` }), FieldKeyError, '舊鑰清單不能含目前版本');
});

test('真實姓名：正規化與遮罩；數字、@、太短太長擋下', () => {
  assert.equal(normalizeLegalName('  施　允瀚 '), '施 允瀚');
  assert.equal(maskLegalName('施允瀚'), '施＊瀚');
  assert.equal(maskLegalName('王明'), '王＊');
  assert.equal(maskLegalName('歐陽娜娜'), '歐＊＊娜');
  for (const bad of ['A123456789', 'a@b.c', '施', 'x'.repeat(41), 123]) assert.throws(() => normalizeLegalName(bad), LegalNameInputError, String(bad));
});

test('log 遮蔽：密碼、真實姓名、身分證、ID token、authorization、金鑰不論在哪一層都換成 [已遮蔽]', () => {
  const chunks: string[] = [];
  const sink = new Writable({
    write(c, _e, cb) {
      chunks.push(String(c));
      cb();
    },
  });
  const log = pino(loggerOptions, sink);
  const SECRET = 'TestPw-9f8e7d!';
  log.info({ password: SECRET, body: { pdfPassword: SECRET, legalName: NAME, idNumber: 'A123456789' }, req: { headers: { authorization: `Bearer ${SECRET}` } }, idToken: SECRET }, 'x');
  log.error({ err: { password: SECRET }, LEDGER_FIELD_KEY: K1 }, 'y');
  const out = chunks.join('');
  assert.ok(!out.includes(SECRET), out);
  assert.ok(!out.includes(NAME) && !out.includes('A123456789') && !out.includes(K1));
  assert.ok(out.includes(REDACT_CENSOR));
});

test('金鑰不在 repo：任何追蹤檔案都沒有 LEDGER_FIELD_KEY=<值>', () => {
  const root = join(__dirname, '..', '..');
  const skip = new Set(['node_modules', '.git', '.next', 'dist']);
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (skip.has(n)) continue;
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.size < 2_000_000 && /\.(ts|tsx|js|mjs|cjs|json|md|sh|yml|yaml|env|example|txt|sql|prisma)$|^\.env/.test(n)) files.push(p);
    }
  };
  walk(root);
  const hits = files.filter((f) => /LEDGER_FIELD_KEY(?:S_OLD)?\s*[=:]\s*['"]?(?:\d+:)?[A-Za-z0-9+/_-]{40,}/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
});
