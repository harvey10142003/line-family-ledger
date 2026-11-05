-- 臺銀牌告匯率：從第 3 批（feat/finance-hub-p1-batch3 b66fcf2）執行 prisma db push 時的預期 SQL
-- 產生方式：prisma migrate diff --from-url <已套 b66fcf2 結構的庫> --to-schema-datamodel prisma/schema.prisma --script
--
-- 只有兩件事，都不刪資料、不改既有欄位：
--   1. Transaction 加 fxRate／fxRateDate／fxRateSource（皆可為 null）：外幣估台幣用了哪個匯率與牌告日期
--   2. 新表 FxRateDaily（每營業日每幣一列；唯一鍵 currency＋rateDate 加在新表上，不觸發資料遺失警告）
--
-- 本機驗證（PostgreSQL 18，embedded）：
--   - b66fcf2 結構＋假資料（2 筆 Transaction，含 1 筆 USD 外幣）→ db push（不帶 --accept-data-loss）通過，
--     舊欄位逐列逐值相同、新 3 欄皆 NULL
--   - 升級後結構與乾淨庫 db push 的結構 migrate diff --exit-code＝0（完全一致）
--
-- 回退注意：回 b66fcf2 映像時舊 schema 的 db push 會想刪 FxRateDaily 與 3 欄 → 用 SKIP_DB_PUSH（見 rollback.md）。

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "fxRate" DECIMAL(14,6),
ADD COLUMN     "fxRateDate" DATE,
ADD COLUMN     "fxRateSource" TEXT;

-- CreateTable
CREATE TABLE "FxRateDaily" (
    "id" TEXT NOT NULL,
    "rateDate" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "spotBuy" DECIMAL(14,6),
    "spotSell" DECIMAL(14,6),
    "cashBuy" DECIMAL(14,6),
    "cashSell" DECIMAL(14,6),
    "source" TEXT NOT NULL DEFAULT 'BOT',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxRateDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FxRateDaily_currency_rateDate_key" ON "FxRateDaily"("currency", "rateDate");

