// 敏感欄位金鑰輪替：把「不是目前版本」的密文用舊金鑰解開、用目前金鑰重加密。
//
// 步驟（docs/deploy/field-encryption.md）：
// 1. 產新金鑰；env 設 LEDGER_FIELD_KEY=新、LEDGER_FIELD_KEY_VERSION=舊版+1、LEDGER_FIELD_KEYS_OLD=舊版:舊金鑰，重啟。
// 2. 跑 `node server/dist/scripts/rotate-field-key.js`（先 --dry-run 看數量）。
// 3. 再跑一次 --dry-run 確認剩 0，才能把 LEDGER_FIELD_KEYS_OLD 拿掉。
// 每一列各自一個交易（改密文＋寫稽核）；某列解不開就跳過並計數，不中斷其他列。
import { prisma } from '../prisma';
import { cipherVersion, fieldKeyStatus, needsReencrypt, reencryptField } from '../lib/field-crypto';
import { auditCreateOp } from './audit';

export interface RotationReport {
  currentVersion: number;
  scanned: number;
  needed: number;
  rotated: number;
  failed: number;
  byVersion: Record<string, number>;
}

export async function rotateFieldKeys(opts: { dryRun?: boolean } = {}): Promise<RotationReport> {
  const st = fieldKeyStatus();
  if (!st.ok) throw new Error(`field key unavailable: ${st.reason}`);
  const rows = await prisma.familyMember.findMany({ where: { legalNameEnc: { not: null } }, select: { id: true, familyId: true, legalNameEnc: true } });
  const report: RotationReport = { currentVersion: st.version, scanned: rows.length, needed: 0, rotated: 0, failed: 0, byVersion: {} };
  for (const r of rows) {
    const enc = r.legalNameEnc!;
    const v = String(cipherVersion(enc) ?? 'unknown');
    report.byVersion[v] = (report.byVersion[v] ?? 0) + 1;
    if (!needsReencrypt(enc)) continue;
    report.needed++;
    if (opts.dryRun) continue;
    try {
      const next = reencryptField(enc, { purpose: 'member.legalName', recordId: r.id });
      await prisma.$transaction([
        prisma.familyMember.update({ where: { id: r.id }, data: { legalNameEnc: next } }),
        auditCreateOp({
          familyId: r.familyId,
          actorMemberId: null,
          channel: 'SYSTEM',
          action: 'FIELD_KEY_ROTATE',
          targetType: 'MEMBER',
          targetId: r.id,
          subjectMemberId: r.id,
          detail: { field: 'legalNameEnc', fromVersion: v, toVersion: st.version },
        }),
      ]);
      report.rotated++;
    } catch {
      report.failed++;
    }
  }
  return report;
}
