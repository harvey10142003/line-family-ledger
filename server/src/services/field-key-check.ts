// 開機自我檢查（LOW-2）：資料庫裡已經有密文時，用目前的金鑰環試解（每個密文版本各一筆）。
// 解不開＝部署的金鑰跟寫入時的不是同一把（貼錯、換機沒帶到、輪替漏設舊金鑰）→ 寫 error log，/health 回 fieldKeyMismatch:true。
// 只回 true/false，不回原因、不輸出任何密文或明文。
import { prisma } from '../prisma';
import { cipherVersion, decryptField, fieldKeyStatus } from '../lib/field-crypto';
import { logger } from '../logger';

/** null＝還沒檢查完，或金鑰本身不可用（看 fieldKey）；false＝試解成功或還沒有密文；true＝解不開。 */
let mismatch: boolean | null = null;

export function fieldKeyMismatch(): boolean | null {
  return mismatch;
}

export async function checkFieldKeyAgainstDb(
  opts: { env?: Record<string, string | undefined>; familyId?: string } = {}, // 測試用：指定金鑰 env、只看某個家庭
): Promise<{ checked: number; failed: number; mismatch: boolean | null }> {
  const env = opts.env ?? process.env;
  if (!fieldKeyStatus(env).ok) {
    mismatch = null;
    return { checked: 0, failed: 0, mismatch };
  }
  const rows = await prisma.familyMember.findMany({
    where: { legalNameEnc: { not: null }, ...(opts.familyId ? { familyId: opts.familyId } : {}) },
    select: { id: true, legalNameEnc: true },
    orderBy: { id: 'asc' },
    take: 200,
  });
  // 每個金鑰版本試一筆就夠（同一版本同一把鑰匙）
  const sample = new Map<string, { id: string; enc: string }>();
  for (const r of rows) {
    const v = String(cipherVersion(r.legalNameEnc!) ?? 'unknown');
    if (!sample.has(v)) sample.set(v, { id: r.id, enc: r.legalNameEnc! });
  }
  let failed = 0;
  const failedVersions: string[] = [];
  for (const [v, s] of sample) {
    try {
      decryptField(s.enc, { purpose: 'member.legalName', recordId: s.id }, env);
    } catch {
      failed++;
      failedVersions.push(v);
    }
  }
  mismatch = failed > 0;
  if (mismatch) {
    logger.error({ failedVersions, checkedVersions: [...sample.keys()] }, 'field key self-check failed: existing ciphertext cannot be decrypted with the configured key');
  } else if (sample.size) {
    logger.info({ checkedVersions: [...sample.keys()] }, 'field key self-check passed');
  }
  return { checked: sample.size, failed, mismatch };
}

/** 只給測試用 */
export function resetFieldKeyMismatchForTest(): void {
  mismatch = null;
}
