ALTER TABLE "EmployeeTransferRequest"
ADD COLUMN IF NOT EXISTS "employeeCodeAtTransfer" TEXT,
ADD COLUMN IF NOT EXISTS "employeeNameAtTransfer" TEXT;

CREATE INDEX IF NOT EXISTS "EmployeeTransferRequest_employeeCodeAtTransfer_idx"
ON "EmployeeTransferRequest"("employeeCodeAtTransfer");

ALTER TABLE "Operation"
ADD COLUMN IF NOT EXISTS "fuelerEmployeeIdAtOperation" TEXT,
ADD COLUMN IF NOT EXISTS "fuelerNameAtOperation" TEXT;

CREATE INDEX IF NOT EXISTS "Operation_fuelerEmployeeIdAtOperation_idx"
ON "Operation"("fuelerEmployeeIdAtOperation");
