-- CreateEnum
CREATE TYPE "ImportType" AS ENUM ('PROJECTS', 'EMPLOYEES', 'ASSETS', 'STATIONS', 'OPENING_VALUES', 'HISTORICAL_OPERATIONS');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('UPLOADED', 'VALIDATING', 'VALIDATED', 'READY_TO_IMPORT', 'IMPORTING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportExecutionMode" AS ENUM ('ALL_OR_NOTHING');

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "importType" "ImportType" NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "validationVersion" INTEGER NOT NULL DEFAULT 1,
    "templateLanguage" TEXT,
    "originalFileName" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "fileHash" TEXT NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'UPLOADED',
    "executionMode" "ImportExecutionMode" NOT NULL DEFAULT 'ALL_OR_NOTHING',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "warningRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "uploadedByUserId" TEXT NOT NULL,
    "confirmedByUserId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validatedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "sourceData" JSONB NOT NULL,
    "normalizedData" JSONB,
    "computedData" JSONB,
    "errors" JSONB,
    "warnings" JSONB,
    "isValid" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBatch_companyId_idx" ON "ImportBatch"("companyId");

-- CreateIndex
CREATE INDEX "ImportBatch_importType_idx" ON "ImportBatch"("importType");

-- CreateIndex
CREATE INDEX "ImportBatch_status_idx" ON "ImportBatch"("status");

-- CreateIndex
CREATE INDEX "ImportBatch_uploadedByUserId_idx" ON "ImportBatch"("uploadedByUserId");

-- CreateIndex
CREATE INDEX "ImportBatch_uploadedAt_idx" ON "ImportBatch"("uploadedAt");

-- CreateIndex
CREATE INDEX "ImportRow_batchId_idx" ON "ImportRow"("batchId");

-- CreateIndex
CREATE INDEX "ImportRow_isValid_idx" ON "ImportRow"("isValid");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_batchId_rowNumber_key" ON "ImportRow"("batchId", "rowNumber");

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_confirmedByUserId_fkey" FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

