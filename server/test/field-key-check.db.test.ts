// LOW-2：/health 的金鑰指紋＋開機自我檢查（資料庫已有密文時試解一筆，解不開＝fieldKeyMismatch:true）。
//   LEDGER_TEST_DATABASE_URL=postgresql://user@127.0.0.1:5432/ledger_test npm --workspace server test
// 指紋部分不需要資料庫；自我檢查需要（沒設就跳過）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { encryptField, fieldKeyFingerprint, fingerprintOfKeyString } from '../src/lib/field-crypto';

const DB_URL = process.env.LEDGER_TEST_DATABASE_URL ?? '';
const SKIP = !DB_URL ? 'LEDGER_TEST_DATABASE_URL 未設（需要本機拋棄式 PostgreSQL）' : false;
if (DB_URL && !/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(DB_URL)) {
  throw new Error('LEDGER_TEST_DATABASE_URL 只能指向 127.0.0.1／localhost 的測試庫');
}

const RUN = randomBytes(4).toString('hex');
const FAM = `famK_${RUN}`;
const MEM = `mK_${RUN}`;
const K1 = randomBytes(32).toString('hex');
const K2 = randomBytes(32).toString('hex');
let prisma: any;

test('指紋＝sha256(金鑰 32 bytes) 前 8 碼；hex／base64 同一把金鑰指紋相同；不含金鑰本身；沒金鑰回 null', () => {
  const raw = Buffer.from(K1, 'hex');
  const fp = fieldKeyFingerprint({ LEDGER_FIELD_KEY: K1 });
  assert.equal(fp, createHash('sha256').update(raw).digest('hex').slice(0, 8));
  assert.match(fp!, /^[0-9a-f]{8}$/);
  assert.equal(fingerprintOfKeyString(raw.toString('base64')), fp);
  assert.equal(fingerprintOfKeyString(raw.toString('base64url')), fp);
  assert.notEqual(fieldKeyFingerprint({ LEDGER_FIELD_KEY: K2 }), fp);
  assert.equal(fieldKeyFingerprint({}), null);
  assert.equal(fieldKeyFingerprint({ LEDGER_FIELD_KEY: 'too-short' }), null);
});

before(async () => {
  if (SKIP) return;
  process.env.DATABASE_URL = DB_URL;
  process.env.LINE_CHANNEL_SECRET ??= 'test-secret';
  process.env.LINE_CHANNEL_ACCESS_TOKEN ??= 'test-token';
  process.env.LINE_LOGIN_CHANNEL_ID ??= '1234567890';
  process.env.LINE_LIFF_ID ??= '1234567890-test';
  process.env.GEMINI_API_KEY ??= 'test-gemini';
  ({ prisma } = await import('../src/prisma'));
  await prisma.family.create({ data: { id: FAM, name: '金鑰檢查家', familyCode: RUN.slice(0, 6).toUpperCase(), ownerLineId: `UK_${RUN}` } });
  await prisma.familyMember.create({ data: { id: MEM, familyId: FAM, lineUserId: `UK_${RUN}`, displayName: 'K', role: 'OWNER' } });
});

after(async () => {
  if (SKIP) return;
  await prisma.familyMember.deleteMany({ where: { familyId: FAM } });
  await prisma.family.delete({ where: { id: FAM } });
  await prisma.$disconnect();
});

test('開機自我檢查：還沒有密文＝false；同一把金鑰解得開＝false；換成別把金鑰＝true；沒金鑰＝null', { skip: SKIP }, async () => {
  const { checkFieldKeyAgainstDb, fieldKeyMismatch } = await import('../src/services/field-key-check');
  const env1 = { LEDGER_FIELD_KEY: K1 };
  assert.deepEqual(await checkFieldKeyAgainstDb({ env: env1, familyId: FAM }), { checked: 0, failed: 0, mismatch: false });

  const enc = encryptField('施允瀚', { purpose: 'member.legalName', recordId: MEM }, env1);
  await prisma.familyMember.update({ where: { id: MEM }, data: { legalNameEnc: enc } });
  assert.deepEqual(await checkFieldKeyAgainstDb({ env: env1, familyId: FAM }), { checked: 1, failed: 0, mismatch: false });
  assert.equal(fieldKeyMismatch(), false);

  assert.deepEqual(await checkFieldKeyAgainstDb({ env: { LEDGER_FIELD_KEY: K2 }, familyId: FAM }), { checked: 1, failed: 1, mismatch: true });
  assert.equal(fieldKeyMismatch(), true, '/health 會回 fieldKeyMismatch:true');

  // 輪替期間：目前 v2＋舊 v1 → v1 密文解得開
  assert.equal((await checkFieldKeyAgainstDb({ env: { LEDGER_FIELD_KEY: K2, LEDGER_FIELD_KEY_VERSION: '2', LEDGER_FIELD_KEYS_OLD: `1:${K1}` }, familyId: FAM })).mismatch, false);

  assert.equal((await checkFieldKeyAgainstDb({ env: {}, familyId: FAM })).mismatch, null);
});
