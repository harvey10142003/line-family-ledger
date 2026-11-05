// 成員真實姓名（帳單戶名，D12）：只存 AES-256-GCM 密文（FamilyMember.legalNameEnc），用來比對帳單歸屬（P2-4）。
//
// - 只有本人能登記、清除、看自己的（遮罩後）姓名；別人只知道「有沒有登記」都不給。
// - 寫入 fail-closed：金鑰不可用 → 丟 FieldKeyError，不寫明文、不寫入（路由回 503）。
// - 寫入與稽核同一個交易：沒記到稽核就不改。
// - 回給前端只有遮罩（施＊瀚），不回明文；之後真的要用明文的只有後端的帳單歸屬比對。
import { prisma } from '../prisma';
import { decryptField, encryptField, FieldCipherError, FieldKeyError } from '../lib/field-crypto';
import { auditCreateOp, type AuditChannel } from './audit';

const PURPOSE = 'member.legalName' as const;

export class LegalNameInputError extends Error {}

/** 清掉前後空白、全形空白、連續空白；長度 2～40；不能有數字或 @（擋把身分證、Email 誤填進來）。 */
export function normalizeLegalName(raw: unknown): string {
  if (typeof raw !== 'string') throw new LegalNameInputError('legalName must be a string');
  const s = raw.replace(/　/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 40) throw new LegalNameInputError('legalName length must be 2-40');
  if (/[0-9０-９@]/.test(s)) throw new LegalNameInputError('legalName must not contain digits or @');
  return s;
}

/** 施允瀚 → 施＊瀚；王明 → 王＊；英文名 John Smith → J＊＊＊ S＊＊＊h 這種太亂，一律留頭尾、中間打＊。 */
export function maskLegalName(name: string): string {
  const chars = [...name];
  if (chars.length <= 2) return `${chars[0]}＊`;
  return `${chars[0]}${'＊'.repeat(Math.min(chars.length - 2, 6))}${chars[chars.length - 1]}`;
}

export type LegalNameStatus = { registered: false } | { registered: true; masked: string | null; unavailable?: 'key' | 'cipher' };

export async function getLegalNameStatus(memberId: string): Promise<LegalNameStatus> {
  const m = await prisma.familyMember.findUnique({ where: { id: memberId }, select: { legalNameEnc: true } });
  if (!m?.legalNameEnc) return { registered: false };
  try {
    return { registered: true, masked: maskLegalName(decryptField(m.legalNameEnc, { purpose: PURPOSE, recordId: memberId })) };
  } catch (err) {
    if (err instanceof FieldKeyError) return { registered: true, masked: null, unavailable: 'key' };
    if (err instanceof FieldCipherError) return { registered: true, masked: null, unavailable: 'cipher' };
    throw err;
  }
}

/** 給後端比對用（P2-4 帳單歸屬）：解不開丟錯，不回空字串假裝沒登記。 */
export async function readLegalNamePlain(memberId: string): Promise<string | null> {
  const m = await prisma.familyMember.findUnique({ where: { id: memberId }, select: { legalNameEnc: true } });
  if (!m?.legalNameEnc) return null;
  return decryptField(m.legalNameEnc, { purpose: PURPOSE, recordId: memberId });
}

/** 登記或清除（value=null）自己的真實姓名。 */
export async function setLegalName(params: { familyId: string; memberId: string; value: unknown; channel: AuditChannel }): Promise<LegalNameStatus> {
  const clearing = params.value === null || params.value === '';
  // 先加密（金鑰不可用就在這裡丟 FieldKeyError，資料庫完全沒動）
  const cipher = clearing ? null : encryptField(normalizeLegalName(params.value), { purpose: PURPOSE, recordId: params.memberId });
  await prisma.$transaction([
    prisma.familyMember.update({ where: { id: params.memberId }, data: { legalNameEnc: cipher } }),
    auditCreateOp({
      familyId: params.familyId,
      actorMemberId: params.memberId,
      channel: params.channel,
      action: clearing ? 'LEGAL_NAME_CLEAR' : 'LEGAL_NAME_SET',
      targetType: 'MEMBER',
      targetId: params.memberId,
      subjectMemberId: params.memberId,
    }),
  ]);
  return getLegalNameStatus(params.memberId);
}
