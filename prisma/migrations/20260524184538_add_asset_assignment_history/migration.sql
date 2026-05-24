-- CreateEnum
CREATE TYPE "AssetAssignmentType" AS ENUM ('INITIAL_ASSIGNMENT', 'TRANSFER');

-- CreateTable
CREATE TABLE "AssetAssignmentHistory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "fromProjectId" TEXT,
    "toProjectId" TEXT NOT NULL,
    "transferRequestId" TEXT,
    "assignmentType" "AssetAssignmentType" NOT NULL,
    "reason" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetAssignmentHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssetAssignmentHistory_companyId_idx" ON "AssetAssignmentHistory"("companyId");

-- CreateIndex
CREATE INDEX "AssetAssignmentHistory_assetId_idx" ON "AssetAssignmentHistory"("assetId");

-- CreateIndex
CREATE INDEX "AssetAssignmentHistory_fromProjectId_idx" ON "AssetAssignmentHistory"("fromProjectId");

-- CreateIndex
CREATE INDEX "AssetAssignmentHistory_toProjectId_idx" ON "AssetAssignmentHistory"("toProjectId");

-- CreateIndex
CREATE INDEX "AssetAssignmentHistory_transferRequestId_idx" ON "AssetAssignmentHistory"("transferRequestId");

-- CreateIndex
CREATE INDEX "AssetAssignmentHistory_assignedByUserId_idx" ON "AssetAssignmentHistory"("assignedByUserId");

-- CreateIndex
CREATE INDEX "AssetAssignmentHistory_assignedAt_idx" ON "AssetAssignmentHistory"("assignedAt");

-- AddForeignKey
ALTER TABLE "AssetAssignmentHistory" ADD CONSTRAINT "AssetAssignmentHistory_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignmentHistory" ADD CONSTRAINT "AssetAssignmentHistory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignmentHistory" ADD CONSTRAINT "AssetAssignmentHistory_fromProjectId_fkey" FOREIGN KEY ("fromProjectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignmentHistory" ADD CONSTRAINT "AssetAssignmentHistory_toProjectId_fkey" FOREIGN KEY ("toProjectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignmentHistory" ADD CONSTRAINT "AssetAssignmentHistory_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignmentHistory" ADD CONSTRAINT "AssetAssignmentHistory_transferRequestId_fkey" FOREIGN KEY ("transferRequestId") REFERENCES "AssetTransferRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
