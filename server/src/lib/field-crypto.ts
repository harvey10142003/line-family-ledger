// 敏感欄位應用層加密（規格 6.3，P0-3）：AES-256-GCM，金鑰只在部署平台的秘密管理（env），不在 repo、不在資料庫。
//
// 密文格式：`lfe:v<金鑰版本>:<iv>:<tag>:<密文>`（三段都是 base64url）。
// - 每個用途（purpose，例如 member.legalName）用 HKDF-SHA256 從主金鑰衍生自己的子金鑰：一個用途的密文不能拿到另一個用途解。
// - AAD 綁「用途＋那一列的 id」：把 A 成員的密文複製到 B 成員那列會解不開（防搬移）。
// - 金鑰版本：密文自己帶版本，解密時找對應版本的金鑰；新寫入一律用目前版本。輪替＝加一把新金鑰、改目前版本、
//   跑重加密（services/field-key-rotation.ts），全部換完後才能拿掉舊金鑰。
//
// env：
//   LEDGER_FIELD_KEY          目前金鑰，32 bytes（64 個 hex 字元，或 base64／base64url）
//   LEDGER_FIELD_KEY_VERSION  目前金鑰的版本號（正整數，預設 1）
//   LEDGER_FIELD_KEYS_OLD     舊金鑰（輪替期間解舊密文用），格式 `1:<key>,2:<key>`；全部重加密完就清掉
//
// fail-closed：金鑰沒設、長度不對、版本找不到 → 一律丟 FieldKeyError，不退回明文、不寫入。
// 只影響「要寫或讀敏感欄位」的功能；其他記帳功能照常（開機不會因為沒設金鑰而起不來）。
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

export const FIELD_CIPHER_PREFIX = 'lfe:';

/** 已登記的用途；新增用途要加在這裡（子金鑰 info 用它，事後不能改名）。 */
export type FieldPurpose = 'member.legalName' | 'document.password' | 'document.address';

export class FieldKeyError extends Error {
  readonly code = 'field_key_unavailable';
}

export class FieldCipherError extends Error {
  readonly code = 'field_cipher_invalid';
}

type Env = Record<string, string | undefined>;

export interface FieldKeyring {
  current: number;
  keys: Map<number, Buffer>;
}

function parseKey(raw: string, label: string): Buffer {
  const s = raw.trim();
  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(s)) buf = Buffer.from(s, 'hex');
  else buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (buf.length !== 32) throw new FieldKeyError(`${label} must be 32 bytes (got ${buf.length})`);
  return buf;
}

/** 從 env 讀出金鑰環；任何設定錯誤都丟 FieldKeyError（訊息不含金鑰本身）。 */
export function loadKeyring(env: Env = process.env): FieldKeyring {
  const rawCurrent = env.LEDGER_FIELD_KEY;
  if (!rawCurrent || !rawCurrent.trim()) throw new FieldKeyError('LEDGER_FIELD_KEY is not set');
  const vRaw = env.LEDGER_FIELD_KEY_VERSION?.trim() || '1';
  if (!/^[1-9]\d{0,5}$/.test(vRaw)) throw new FieldKeyError('LEDGER_FIELD_KEY_VERSION must be a positive integer');
  const current = Number(vRaw);
  const keys = new Map<number, Buffer>([[current, parseKey(rawCurrent, 'LEDGER_FIELD_KEY')]]);
  for (const entry of (env.LEDGER_FIELD_KEYS_OLD ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^([1-9]\d{0,5}):(.+)$/.exec(entry);
    if (!m) throw new FieldKeyError('LEDGER_FIELD_KEYS_OLD must look like "1:<key>,2:<key>"');
    const v = Number(m[1]);
    if (v === current) throw new FieldKeyError('LEDGER_FIELD_KEYS_OLD must not contain the current version');
    keys.set(v, parseKey(m[2], `LEDGER_FIELD_KEYS_OLD v${v}`));
  }
  return { current, keys };
}

let cached: { env: Env; snapshot: string; ring: FieldKeyring } | null = null;

function ring(env: Env): FieldKeyring {
  const snapshot = `${env.LEDGER_FIELD_KEY ?? ''}|${env.LEDGER_FIELD_KEY_VERSION ?? ''}|${env.LEDGER_FIELD_KEYS_OLD ?? ''}`;
  if (cached && cached.env === env && cached.snapshot === snapshot) return cached.ring;
  const r = loadKeyring(env);
  cached = { env, snapshot, ring: r };
  return r;
}

/** 金鑰是否可用（給開機檢查、健康檢查；不丟錯）。 */
export function fieldKeyStatus(env: Env = process.env): { ok: true; version: number; versions: number[] } | { ok: false; reason: string } {
  try {
    const r = ring(env);
    return { ok: true, version: r.current, versions: [...r.keys.keys()].sort((a, b) => a - b) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function subkey(master: Buffer, purpose: FieldPurpose): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `line-family-ledger:field:${purpose}:v1`, 32));
}

function aadOf(purpose: FieldPurpose, recordId: string): Buffer {
  if (!recordId) throw new FieldCipherError('recordId (AAD) required');
  return Buffer.from(`${purpose}|${recordId}`, 'utf8');
}

const b64u = (b: Buffer) => b.toString('base64url');

export interface FieldContext {
  purpose: FieldPurpose;
  /** 那一列的 id（成員 id、文件 id），綁進 AAD */
  recordId: string;
}

export function encryptField(plaintext: string, ctx: FieldContext, env: Env = process.env): string {
  const r = ring(env);
  const key = subkey(r.keys.get(r.current)!, ctx.purpose);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aadOf(ctx.purpose, ctx.recordId));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `${FIELD_CIPHER_PREFIX}v${r.current}:${b64u(iv)}:${b64u(c.getAuthTag())}:${b64u(ct)}`;
}

export function cipherVersion(cipher: string): number | null {
  const m = /^lfe:v(\d+):/.exec(cipher);
  return m ? Number(m[1]) : null;
}

export function isFieldCipher(v: unknown): v is string {
  return typeof v === 'string' && /^lfe:v\d+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$/.test(v);
}

export function decryptField(cipher: string, ctx: FieldContext, env: Env = process.env): string {
  if (!isFieldCipher(cipher)) throw new FieldCipherError('not a field cipher');
  const [, ver, ivS, tagS, ctS] = /^lfe:v(\d+):([^:]+):([^:]+):(.*)$/.exec(cipher)!;
  const r = ring(env);
  const master = r.keys.get(Number(ver));
  if (!master) throw new FieldKeyError(`no key for version ${ver}`);
  const iv = Buffer.from(ivS, 'base64url');
  const tag = Buffer.from(tagS, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new FieldCipherError('bad iv/tag length');
  try {
    const d = createDecipheriv('aes-256-gcm', subkey(master, ctx.purpose), iv);
    d.setAAD(aadOf(ctx.purpose, ctx.recordId));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(Buffer.from(ctS, 'base64url')), d.final()]).toString('utf8');
  } catch {
    // 金鑰不對、被竄改、搬到別列（AAD 不符）都會到這裡；訊息不帶任何內容
    throw new FieldCipherError('decrypt failed (wrong key, tampered, or moved to another record)');
  }
}

/** 密文不是用目前版本加密的 → 需要重加密。 */
export function needsReencrypt(cipher: string, env: Env = process.env): boolean {
  return cipherVersion(cipher) !== ring(env).current;
}

/** 用舊版金鑰解開、再用目前版本加密（輪替用）。已經是目前版本就原樣回傳。 */
export function reencryptField(cipher: string, ctx: FieldContext, env: Env = process.env): string {
  if (!needsReencrypt(cipher, env)) return cipher;
  return encryptField(decryptField(cipher, ctx, env), ctx, env);
}

/** 只給測試用：清掉金鑰快取。 */
export function resetFieldKeyCacheForTest(): void {
  cached = null;
}

/**
 * 目前金鑰的指紋（LOW-2）：sha256(金鑰的 32 bytes) 的前 8 個 hex 字元。給 /health 與離線備份核對用——
 * 只露 32 bits 的雜湊，推不回金鑰；金鑰本身絕不輸出。金鑰不可用時回 null。
 * 離線核對（備份的金鑰）：在本機跑 `node server/dist/scripts/field-key-fingerprint.js`，從標準輸入貼上金鑰（不進 shell 歷史）。
 */
export function fieldKeyFingerprint(env: Env = process.env): string | null {
  try {
    const r = ring(env);
    return keyFingerprint(r.keys.get(r.current)!);
  } catch {
    return null;
  }
}

/** 金鑰字串（hex／base64／base64url）→ 指紋；格式不對丟 FieldKeyError。 */
export function fingerprintOfKeyString(raw: string): string {
  return keyFingerprint(parseKey(raw, 'key'));
}

export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}
