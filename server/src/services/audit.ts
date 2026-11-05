// 稽核紀錄（財務中樞 P0-4，規格 6.8）：誰在何時、從哪裡（LIFF／LINE／系統）看了或動了誰的東西。
//
// 只加不改：這支只有 create；資料庫的 trigger（ensureAuditAppendOnly）擋 UPDATE／DELETE／TRUNCATE。
// 記什麼：
// - VIEW_PERSONAL：看到「別人個人帳戶／卡／負債」的明細（交易列表、轉帳列表、負債攤還表與繳款、卡帳單、匯出）。
//   同一個人看同一個人的同一種畫面 10 分鐘內只記一次（LIFF 切頁會一直重抓）；匯出每次都記。
// - EDIT／DELETE：改、刪交易（LIFF 與 LINE 快速修正）、帳戶／卡／負債修改、固定收支與儲蓄目標刪除、轉帳撤銷／改帳。
// - PERMISSION_CHANGE：帳戶／卡／負債的歸屬或可見範圍改變、成員加入家庭。
// - EXPORT_CSV、CONFIRM／REJECT（D18 對方確認）、LEGAL_NAME_SET／LEGAL_NAME_CLEAR、FIELD_KEY_ROTATE。
// detail 只放 id、欄位名稱、列舉值、筆數；字串一律截短、禁用欄位名直接丟錯（不讓備註、姓名、密碼混進來）。
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../prisma';
import { logger } from '../logger';
import type { AccessScope } from '../lib/access';

export type AuditChannel = 'LIFF' | 'LINE' | 'SYSTEM';
export type AuditAction =
  | 'VIEW_PERSONAL'
  | 'EDIT'
  | 'DELETE'
  | 'UNDO'
  | 'CONFIRM'
  | 'REJECT'
  | 'EXPORT_CSV'
  | 'PERMISSION_CHANGE'
  | 'MEMBER_JOIN'
  | 'LEGAL_NAME_SET'
  | 'LEGAL_NAME_CLEAR'
  | 'FIELD_KEY_ROTATE';
export type AuditTargetType =
  | 'TRANSACTION'
  | 'TRANSACTION_LIST'
  | 'TRANSFER'
  | 'TRANSFER_LIST'
  | 'ACCOUNT'
  | 'CREDIT_CARD'
  | 'CARD_STATEMENT'
  | 'LIABILITY'
  | 'RECURRING'
  | 'SAVINGS_GOAL'
  | 'MEMBER'
  | 'EXPORT';

type DetailValue = string | number | boolean | null | string[];
export type AuditDetail = Record<string, DetailValue>;

export interface AuditEvent {
  familyId: string;
  actorMemberId: string | null;
  channel: AuditChannel;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId?: string | null;
  subjectMemberId?: string | null;
  detail?: AuditDetail;
}

// 這些名字不能出現在 detail（就算值是空的也不行，避免之後有人把原文塞進來）
const FORBIDDEN_DETAIL_KEYS = /^(note|text|sentence|legalName|name|displayName|password|idNumber|address|email|phone|token|raw)$/i;
const MAX_STR = 80;

export class AuditDetailError extends Error {}

export function sanitizeDetail(detail: AuditDetail | undefined): Prisma.InputJsonValue | undefined {
  if (!detail) return undefined;
  const out: Record<string, DetailValue> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (FORBIDDEN_DETAIL_KEYS.test(k)) throw new AuditDetailError(`audit detail key not allowed: ${k}`);
    if (typeof v === 'string') out[k] = v.slice(0, MAX_STR);
    else if (Array.isArray(v)) out[k] = v.slice(0, 50).map((x) => String(x).slice(0, MAX_STR));
    else out[k] = v;
  }
  return out as Prisma.InputJsonValue;
}

type Db = Pick<PrismaClient, 'auditLog'> | Prisma.TransactionClient;

function toRow(ev: AuditEvent): Prisma.AuditLogUncheckedCreateInput {
  return {
    familyId: ev.familyId,
    actorMemberId: ev.actorMemberId,
    channel: ev.channel,
    action: ev.action,
    targetType: ev.targetType,
    targetId: ev.targetId ?? null,
    subjectMemberId: ev.subjectMemberId ?? null,
    detail: sanitizeDetail(ev.detail),
  };
}

/** 寫一筆；失敗丟錯（給「沒記到就不能做」的地方：匯出、真實姓名、跟資料一起進同一個交易）。 */
export async function writeAudit(ev: AuditEvent, db: Db = prisma): Promise<void> {
  await db.auditLog.create({ data: toRow(ev) });
}

/** 給 prisma.$transaction([...]) 用：跟資料修改一起成功或一起失敗。 */
export function auditCreateOp(ev: AuditEvent) {
  return prisma.auditLog.create({ data: toRow(ev) });
}

/** 盡力寫：資料已經改完了，稽核寫失敗只記錯誤（不把已成功的操作回成失敗）。 */
export async function recordAudit(ev: AuditEvent): Promise<void> {
  try {
    await writeAudit(ev);
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err), action: ev.action, targetType: ev.targetType }, 'audit write failed');
  }
}

/**
 * 一筆東西的「主人」：付款帳戶／卡／負債的 ownerMemberId 裡，優先挑不是操作者本人的那位（別人的被動到才是重點），
 * 都是本人的就回本人，全部共同回 null。
 */
export function pickSubject(owners: (string | null | undefined)[], actorMemberId: string | null): string | null {
  const set = owners.filter((x): x is string => !!x);
  return set.find((o) => o !== actorMemberId) ?? set[0] ?? null;
}

export function txSubject(scope: AccessScope, tx: { accountId?: string | null; creditCardId?: string | null }): string | null {
  return pickSubject(
    [tx.accountId ? scope.account(tx.accountId)?.ownerMemberId : null, tx.creditCardId ? scope.card(tx.creditCardId)?.ownerMemberId : null],
    scope.memberId,
  );
}

export function transferSubject(
  scope: AccessScope,
  tr: { fromAccountId?: string | null; toAccountId?: string | null; toCreditCardId?: string | null; fromLiabilityId?: string | null; toLiabilityId?: string | null },
): string | null {
  return pickSubject(
    [
      tr.fromAccountId ? scope.account(tr.fromAccountId)?.ownerMemberId : null,
      tr.toAccountId ? scope.account(tr.toAccountId)?.ownerMemberId : null,
      tr.toCreditCardId ? scope.card(tr.toCreditCardId)?.ownerMemberId : null,
      tr.fromLiabilityId ? scope.liability(tr.fromLiabilityId)?.ownerMemberId : null,
      tr.toLiabilityId ? scope.liability(tr.toLiabilityId)?.ownerMemberId : null,
    ],
    scope.memberId,
  );
}

/** 轉帳 id → 主人（撤銷、確認這類只拿到 id 的地方用）。查不到回 null。 */
export async function transferSubjectById(scope: AccessScope, transferId: string): Promise<string | null> {
  const tr = await prisma.transfer.findFirst({
    where: { id: transferId, familyId: scope.familyId },
    select: { fromAccountId: true, toAccountId: true, toCreditCardId: true, fromLiabilityId: true, toLiabilityId: true },
  });
  return tr ? transferSubject(scope, tr) : null;
}

// ---- 看到別人的個人明細 ----

const VIEW_DEDUPE_MS = 10 * 60 * 1000;
const recentViews = new Map<string, number>();

/**
 * 從回傳給前端的列表算出「看到了哪些人的個人明細」，每位主人寫一筆 VIEW_PERSONAL。
 * owners：列表裡每一筆的主人（共同＝null）；本人自己的不記。
 */
export async function recordPersonalViews(params: {
  scope: AccessScope;
  channel: AuditChannel;
  targetType: AuditTargetType;
  targetId?: string | null;
  owners: (string | null | undefined)[];
  detail?: AuditDetail;
  /** 匯出等每次都要記的不去重 */
  dedupe?: boolean;
  now?: number;
}): Promise<void> {
  const { scope } = params;
  const counts = new Map<string, number>();
  for (const o of params.owners) if (o && o !== scope.memberId) counts.set(o, (counts.get(o) ?? 0) + 1);
  const now = params.now ?? Date.now();
  for (const [subject, count] of counts) {
    const key = `${scope.familyId}|${scope.memberId}|${subject}|${params.targetType}|${params.targetId ?? ''}|${params.detail?.month ?? ''}`;
    if (params.dedupe !== false) {
      const last = recentViews.get(key);
      if (last && now - last < VIEW_DEDUPE_MS) continue;
      recentViews.set(key, now);
      if (recentViews.size > 5000) recentViews.clear();
    }
    await recordAudit({
      familyId: scope.familyId,
      actorMemberId: scope.memberId,
      channel: params.channel,
      action: 'VIEW_PERSONAL',
      targetType: params.targetType,
      targetId: params.targetId ?? null,
      subjectMemberId: subject,
      detail: { ...(params.detail ?? {}), count },
    });
  }
}

/** 只給測試用：清掉 10 分鐘去重的記憶。 */
export function resetViewDedupeForTest(): void {
  recentViews.clear();
}

// ---- 資料庫層的「只加不改」 ----

/** 開機時建 trigger：任何 UPDATE／DELETE／TRUNCATE AuditLog 都會被資料庫拒絕。重複執行沒關係。 */
export async function ensureAuditAppendOnly(db: Pick<PrismaClient, '$executeRawUnsafe'> = prisma): Promise<void> {
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ledger_audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'AuditLog is append-only (% blocked)', TG_OP USING ERRCODE = 'P0001';
    END
    $fn$`);
  await db.$executeRawUnsafe(`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_append_only_row' AND tgrelid = '"AuditLog"'::regclass) THEN
        CREATE TRIGGER audit_log_append_only_row BEFORE UPDATE OR DELETE ON "AuditLog"
          FOR EACH ROW EXECUTE FUNCTION ledger_audit_log_append_only();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_append_only_truncate' AND tgrelid = '"AuditLog"'::regclass) THEN
        CREATE TRIGGER audit_log_append_only_truncate BEFORE TRUNCATE ON "AuditLog"
          FOR EACH STATEMENT EXECUTE FUNCTION ledger_audit_log_append_only();
      END IF;
    END
    $do$`);
}

// ---- 讀：LIFF「誰看過／動過我的資料」 ----

export interface AuditView {
  id: string;
  at: string;
  channel: string;
  action: string;
  targetType: string;
  targetId: string | null;
  actorName: string | null;
  isMine: boolean;
  aboutMe: boolean;
  detail: Prisma.JsonValue | null;
}

/**
 * mine：別人對「我的」東西做的事（subject＝我、操作者不是我）。
 * family：我能看的全家紀錄＝共同的（subject 為 null）＋跟我有關的（我做的或關於我的）。別人對他自己個人東西的操作不給看。
 */
export async function listAuditForMember(familyId: string, memberId: string, scopeKind: 'mine' | 'family', limit = 100): Promise<AuditView[]> {
  const where: Prisma.AuditLogWhereInput =
    scopeKind === 'mine'
      ? { familyId, subjectMemberId: memberId, NOT: { actorMemberId: memberId } }
      : { familyId, OR: [{ subjectMemberId: null }, { subjectMemberId: memberId }, { actorMemberId: memberId }] };
  const [rows, members] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(limit, 1), 200) }),
    prisma.familyMember.findMany({ where: { familyId }, select: { id: true, displayName: true } }),
  ]);
  const names = new Map(members.map((m) => [m.id, m.displayName]));
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt.toISOString(),
    channel: r.channel,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    actorName: r.actorMemberId ? names.get(r.actorMemberId) ?? '已離開的成員' : null,
    isMine: r.actorMemberId === memberId,
    aboutMe: r.subjectMemberId === memberId,
    detail: r.detail,
  }));
}
