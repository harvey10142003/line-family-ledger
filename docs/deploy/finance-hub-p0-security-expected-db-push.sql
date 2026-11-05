-- 財務中樞 P0-2／P0-3／P0-4（feat/finance-hub-p0-security）執行 prisma db push 時的預期 SQL
-- 產生方式：prisma migrate diff --from-url <已套 c834706 結構的庫> --to-schema-datamodel prisma/schema.prisma --script
--
-- 只有一件事：新表 AuditLog（稽核紀錄）＋3 個索引。不刪資料、不改既有欄位、不掛外鍵。
-- P0-3 用到的 FamilyMember.legalNameEnc 在 P1-1（8f48bb8）就已經加好，這次不動 schema。
--
-- 本機驗證（PostgreSQL 18.4，embedded，C locale）：
--   - c834706 結構＋假資料（Family 1、FamilyMember 2（其中 1 位 legalNameEnc 有值）、Category 1、Account 1、Transaction 2）
--     → db push（不帶 --accept-data-loss）通過，升級前後所有既有表逐列 to_jsonb 比對完全相同
--   - 預期 SQL 中 DROP／ALTER／RENAME／SET NOT NULL／改型別＝0
--   - 升級後結構與乾淨庫 db push 的結構 migrate diff --exit-code＝0（完全一致）
--
-- db push 不管的部分（server 開機時 ensureAuditAppendOnly() 自己建，重複執行沒關係；放在檔尾供人工核對）：
--   函式 ledger_audit_log_append_only()＋trigger audit_log_append_only_row（BEFORE UPDATE OR DELETE，FOR EACH ROW）
--   ＋audit_log_append_only_truncate（BEFORE TRUNCATE）。prisma db push 不會刪它們。
--   資料庫帳號沒有 CREATE FUNCTION 權限時，開機 log 會有 'audit append-only trigger setup failed'，程式照常（只剩程式層棘輪）。
--
-- 回退注意：回 c834706 以前的映像時，舊 schema 的 db push 會想 DROP TABLE "AuditLog" → 有資料就失敗 → 用 SKIP_DB_PUSH（見 rollback.md）。

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "actorMemberId" TEXT,
    "channel" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "subjectMemberId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_familyId_createdAt_idx" ON "AuditLog"("familyId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_subjectMemberId_createdAt_idx" ON "AuditLog"("subjectMemberId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorMemberId_createdAt_idx" ON "AuditLog"("actorMemberId", "createdAt");


-- ===== 以下由程式在開機時建立（services/audit.ts ensureAuditAppendOnly），不是 db push 產生 =====
-- CREATE OR REPLACE FUNCTION ledger_audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
-- BEGIN
--   RAISE EXCEPTION 'AuditLog is append-only (% blocked)', TG_OP USING ERRCODE = 'P0001';
-- END
-- $fn$;
-- CREATE TRIGGER audit_log_append_only_row BEFORE UPDATE OR DELETE ON "AuditLog"
--   FOR EACH ROW EXECUTE FUNCTION ledger_audit_log_append_only();
-- CREATE TRIGGER audit_log_append_only_truncate BEFORE TRUNCATE ON "AuditLog"
--   FOR EACH STATEMENT EXECUTE FUNCTION ledger_audit_log_append_only();
