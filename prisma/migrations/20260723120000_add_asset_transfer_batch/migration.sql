ALTER TABLE "AssetTransferRequest"
ADD COLUMN "transferBatchId" TEXT;

CREATE INDEX "AssetTransferRequest_transferBatchId_idx"
ON "AssetTransferRequest"("transferBatchId");