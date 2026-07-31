ALTER TABLE "EmployeeTransferRequest"
ADD COLUMN IF NOT EXISTS "transferBatchId" TEXT;

CREATE INDEX IF NOT EXISTS "EmployeeTransferRequest_transferBatchId_idx"
ON "EmployeeTransferRequest"("transferBatchId");
