-- 財務中樞 P1-1：正式庫（55842f5／7e3a564 結構）執行 prisma db push 時的預期 SQL
-- 產生方式：prisma migrate diff --from-url <已套 55842f5 結構的庫> --to-schema-datamodel prisma/schema.prisma --script
-- 只有 CREATE TYPE / ALTER TYPE ADD VALUE / ADD COLUMN（皆有預設或可為 null）/ CREATE TABLE / CREATE INDEX / ADD FOREIGN KEY；沒有 DROP、改型別、SET NOT NULL
-- ALTER TYPE ... ADD VALUE 需 PostgreSQL 12 以上（正式 GCP 為 PG 18.6）

-- CreateEnum
CREATE TYPE "BookTo" AS ENUM ('FAMILY', 'BUSINESS');

-- CreateEnum
CREATE TYPE "ReimburseStatus" AS ENUM ('NONE', 'PENDING', 'CLAIMED', 'REIMBURSED');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('FAMILY_FULL', 'FAMILY_TOTAL_ONLY', 'OWNER_ONLY');

-- CreateEnum
CREATE TYPE "AccountPurpose" AS ENUM ('FAMILY', 'BUSINESS');

-- CreateEnum
CREATE TYPE "CardStatementStatus" AS ENUM ('OPEN', 'PAID', 'PARTIAL', 'OVERDUE');

-- CreateEnum
CREATE TYPE "LiabilityDirection" AS ENUM ('BORROWED', 'LENT');

-- CreateEnum
CREATE TYPE "LiabilityKind" AS ENUM ('MORTGAGE', 'CAR', 'PERSONAL', 'FAMILY', 'OTHER');

-- CreateEnum
CREATE TYPE "RepaymentMethod" AS ENUM ('EQUAL_PAYMENT', 'EQUAL_PRINCIPAL', 'INTEREST_ONLY', 'FREE');

-- CreateEnum
CREATE TYPE "TransferKind" AS ENUM ('ACCOUNT', 'CARD_PAYMENT', 'CASH_WITHDRAW', 'CASH_DEPOSIT', 'TIME_DEPOSIT', 'LOAN_REPAY', 'LEND', 'BORROW', 'COLLECT', 'SPOUSE');

-- CreateEnum
CREATE TYPE "TransferSource" AS ENUM ('TEXT', 'MANUAL', 'STATEMENT', 'PASSBOOK', 'EMAIL');

-- CreateEnum
CREATE TYPE "ReconcileStatus" AS ENUM ('UNRECONCILED', 'RECONCILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AccountType" ADD VALUE 'TIME_DEPOSIT';
ALTER TYPE "AccountType" ADD VALUE 'SECURITIES';
ALTER TYPE "AccountType" ADD VALUE 'INVESTMENT';
ALTER TYPE "AccountType" ADD VALUE 'CRYPTO';

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "accountLast4" TEXT,
ADD COLUMN     "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'TWD',
ADD COLUMN     "institution" TEXT,
ADD COLUMN     "ownerMemberId" TEXT,
ADD COLUMN     "purpose" "AccountPurpose" NOT NULL DEFAULT 'FAMILY',
ADD COLUMN     "visibility" "Visibility" NOT NULL DEFAULT 'FAMILY_FULL';

-- AlterTable
ALTER TABLE "CreditCard" ADD COLUMN     "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "cardLast4" TEXT,
ADD COLUMN     "isSupplementary" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "issuer" TEXT,
ADD COLUMN     "ownerMemberId" TEXT,
ADD COLUMN     "visibility" "Visibility" NOT NULL DEFAULT 'FAMILY_FULL';

-- AlterTable
ALTER TABLE "FamilyMember" ADD COLUMN     "legalNameEnc" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "amountEstimated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bookTo" "BookTo" NOT NULL DEFAULT 'FAMILY',
ADD COLUMN     "originalAmount" DECIMAL(14,2),
ADD COLUMN     "originalCurrency" TEXT,
ADD COLUMN     "postedAt" TIMESTAMP(3),
ADD COLUMN     "reimburseStatus" "ReimburseStatus" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "cardStatementId" TEXT,
ADD COLUMN     "fee" DECIMAL(14,2),
ADD COLUMN     "fromLiabilityId" TEXT,
ADD COLUMN     "kind" "TransferKind" NOT NULL DEFAULT 'ACCOUNT',
ADD COLUMN     "linkedTransactionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "reconcileStatus" "ReconcileStatus" NOT NULL DEFAULT 'UNRECONCILED',
ADD COLUMN     "source" "TransferSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "toCreditCardId" TEXT,
ADD COLUMN     "toLiabilityId" TEXT,
ADD COLUMN     "undoneAt" TIMESTAMP(3),
ADD COLUMN     "undoneByMemberId" TEXT;

-- CreateTable
CREATE TABLE "CardStatement" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "statementDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "newBalance" DECIMAL(14,2) NOT NULL,
    "minimumDue" DECIMAL(14,2),
    "paidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "CardStatementStatus" NOT NULL DEFAULT 'OPEN',
    "documentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Liability" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "ownerMemberId" TEXT,
    "visibility" "Visibility" NOT NULL DEFAULT 'FAMILY_FULL',
    "direction" "LiabilityDirection" NOT NULL DEFAULT 'BORROWED',
    "kind" "LiabilityKind" NOT NULL DEFAULT 'OTHER',
    "name" TEXT NOT NULL,
    "lender" TEXT,
    "principal" DECIMAL(14,2) NOT NULL,
    "annualRate" DECIMAL(7,4),
    "termMonths" INTEGER,
    "startDate" TIMESTAMP(3),
    "paymentDay" INTEGER,
    "method" "RepaymentMethod" NOT NULL DEFAULT 'FREE',
    "gracePeriodMonths" INTEGER NOT NULL DEFAULT 0,
    "payFromAccountId" TEXT,
    "currentPrincipal" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TWD',
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Liability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiabilityRateChange" (
    "id" TEXT NOT NULL,
    "liabilityId" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "annualRate" DECIMAL(7,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiabilityRateChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiabilityPayment" (
    "id" TEXT NOT NULL,
    "liabilityId" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "principalPart" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "interestPart" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "feePart" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "transactionId" TEXT,
    "transferId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiabilityPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CardStatement_familyId_idx" ON "CardStatement"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "CardStatement_cardId_statementDate_key" ON "CardStatement"("cardId", "statementDate");

-- CreateIndex
CREATE INDEX "Liability_familyId_idx" ON "Liability"("familyId");

-- CreateIndex
CREATE INDEX "Liability_ownerMemberId_idx" ON "Liability"("ownerMemberId");

-- CreateIndex
CREATE INDEX "LiabilityRateChange_liabilityId_effectiveDate_idx" ON "LiabilityRateChange"("liabilityId", "effectiveDate");

-- CreateIndex
CREATE INDEX "LiabilityPayment_liabilityId_paidAt_idx" ON "LiabilityPayment"("liabilityId", "paidAt");

-- CreateIndex
CREATE INDEX "Account_ownerMemberId_idx" ON "Account"("ownerMemberId");

-- CreateIndex
CREATE INDEX "CreditCard_ownerMemberId_idx" ON "CreditCard"("ownerMemberId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_ownerMemberId_fkey" FOREIGN KEY ("ownerMemberId") REFERENCES "FamilyMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditCard" ADD CONSTRAINT "CreditCard_ownerMemberId_fkey" FOREIGN KEY ("ownerMemberId") REFERENCES "FamilyMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardStatement" ADD CONSTRAINT "CardStatement_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardStatement" ADD CONSTRAINT "CardStatement_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "CreditCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liability" ADD CONSTRAINT "Liability_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liability" ADD CONSTRAINT "Liability_ownerMemberId_fkey" FOREIGN KEY ("ownerMemberId") REFERENCES "FamilyMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liability" ADD CONSTRAINT "Liability_payFromAccountId_fkey" FOREIGN KEY ("payFromAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiabilityRateChange" ADD CONSTRAINT "LiabilityRateChange_liabilityId_fkey" FOREIGN KEY ("liabilityId") REFERENCES "Liability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiabilityPayment" ADD CONSTRAINT "LiabilityPayment_liabilityId_fkey" FOREIGN KEY ("liabilityId") REFERENCES "Liability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_fromLiabilityId_fkey" FOREIGN KEY ("fromLiabilityId") REFERENCES "Liability"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_toCreditCardId_fkey" FOREIGN KEY ("toCreditCardId") REFERENCES "CreditCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_toLiabilityId_fkey" FOREIGN KEY ("toLiabilityId") REFERENCES "Liability"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_cardStatementId_fkey" FOREIGN KEY ("cardStatementId") REFERENCES "CardStatement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

