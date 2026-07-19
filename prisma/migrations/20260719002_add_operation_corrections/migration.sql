-- CreateEnum
CREATE TYPE "OperationCorrectionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'APPLIED');

-- CreateEnum
CREATE TYPE "OperationCorrectionField" AS ENUM ('ASSET_ID', 'SOURCE_STATION_ID', 'DESTINATION_STATION_ID', 'QUANTITY', 'ODOMETER', 'STATION_COUNTER', 'EXTERNAL_STATION_NAME', 'INVOICE_NUMBER', 'TOTAL_COST_AT_OPERATION', 'NOTES');

-- CreateTable
CREATE TABLE "OperationCorrection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "fieldName" "OperationCorrectionField" NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "reason" TEXT NOT NULL,
    "status" "OperationCorrectionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedByUserId" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperationCorrection_companyId_idx" ON "OperationCorrection"("companyId");

-- CreateIndex
CREATE INDEX "OperationCorrection_operationId_idx" ON "OperationCorrection"("operationId");

-- CreateIndex
CREATE INDEX "OperationCorrection_requestedByUserId_idx" ON "OperationCorrection"("requestedByUserId");

-- CreateIndex
CREATE INDEX "OperationCorrection_reviewedByUserId_idx" ON "OperationCorrection"("reviewedByUserId");

-- CreateIndex
CREATE INDEX "OperationCorrection_fieldName_idx" ON "OperationCorrection"("fieldName");

-- CreateIndex
CREATE INDEX "OperationCorrection_status_idx" ON "OperationCorrection"("status");

-- CreateIndex
CREATE INDEX "OperationCorrection_createdAt_idx" ON "OperationCorrection"("createdAt");

-- CreateIndex
CREATE INDEX "OperationCorrection_companyId_status_createdAt_idx" ON "OperationCorrection"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "OperationCorrection_operationId_fieldName_status_idx" ON "OperationCorrection"("operationId", "fieldName", "status");

-- CreateIndex
CREATE INDEX "Operation_companyId_createdAt_idx" ON "Operation"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "Operation_companyId_status_createdAt_idx" ON "Operation"("companyId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "OperationCorrection" ADD CONSTRAINT "OperationCorrection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationCorrection" ADD CONSTRAINT "OperationCorrection_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationCorrection" ADD CONSTRAINT "OperationCorrection_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationCorrection" ADD CONSTRAINT "OperationCorrection_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
