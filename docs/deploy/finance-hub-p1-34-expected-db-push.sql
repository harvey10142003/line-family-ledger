-- 財務中樞 P1-3／P1-4：從第 1 批（feat/finance-hub-p1-batch1 e5fa2f2，含 P1-1 結構）執行 prisma db push 時的預期 SQL
-- 產生方式：prisma migrate diff --from-url <已套 e5fa2f2 結構的庫> --to-schema-datamodel prisma/schema.prisma --script
--
-- 只有三件事，都不刪資料：
--   1. LiabilityPayment 加 undoneAt（可為 null）：轉帳撤銷時一起標記
--   2. Transfer 加 interest（可為 null）：連帶利息
--   3. Transfer.fromAccountId／toAccountId DROP NOT NULL（放寬，舊資料兩端都有值、不變）
-- 外鍵不重建：schema 對兩個關聯明寫 onDelete: Restrict, onUpdate: Cascade，維持原本必填關聯的外鍵行為。
--
-- 本機驗證（PostgreSQL 18.4）：
--   - e5fa2f2 結構＋假資料（3 筆舊轉帳）→ db push（不帶 --accept-data-loss）通過，舊 Transfer 每列每欄逐值相同
--   - 升級後結構與乾淨庫 db push 的結構 migrate diff --exit-code＝0（完全一致）
--   - 55842f5（目前正式）結構直接跳到本版也能 db push（＝P1-1 的 SQL＋下面三件），同樣無 DROP／SET NOT NULL／RENAME
--
-- 回退注意：升級後若回舊映像，舊 schema 的 db push 會想「加回 NOT NULL」與「刪 interest／undoneAt」
--   → 不帶 --accept-data-loss 會失敗、容器起不來；而且只要有一筆繳卡費／還貸款／借入／收回（某端是 null），
--   舊程式的轉帳列表會讀到 null 而出錯。回退前要先有不跑 db push 的啟動方式。

-- AlterTable
ALTER TABLE "LiabilityPayment" ADD COLUMN     "undoneAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "interest" DECIMAL(14,2),
ALTER COLUMN "fromAccountId" DROP NOT NULL,
ALTER COLUMN "toAccountId" DROP NOT NULL;

