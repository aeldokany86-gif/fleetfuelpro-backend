-- Add CANCELLATION as an Operation Correction type and metadata for audit.
ALTER TYPE "OperationCorrectionField"
ADD VALUE IF NOT EXISTS 'CANCELLATION';

ALTER TABLE "OperationCorrection"
ADD COLUMN IF NOT EXISTS "metadata" JSONB;
