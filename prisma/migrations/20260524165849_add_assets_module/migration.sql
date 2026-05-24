-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT,
    "fuelTankCapacity" DOUBLE PRECISION,
    "currentOdometer" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "AssetStatus" NOT NULL DEFAULT 'ACTIVE',
    "projectId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetOdometerReset" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "oldOdometer" DOUBLE PRECISION NOT NULL,
    "newOdometer" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetOdometerReset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetTransferRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "fromProjectId" TEXT NOT NULL,
    "toProjectId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "status" "EmployeeTransferStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "rejectionReason" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetTransferRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetTransferApproval" (
    "id" TEXT NOT NULL,
    "transferRequestId" TEXT NOT NULL,
    "approverUserId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "approvalStage" TEXT NOT NULL,
    "status" "EmployeeTransferApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetTransferApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Asset_companyId_idx" ON "Asset"("companyId");

-- CreateIndex
CREATE INDEX "Asset_projectId_idx" ON "Asset"("projectId");

-- CreateIndex
CREATE INDEX "Asset_status_idx" ON "Asset"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_companyId_assetId_key" ON "Asset"("companyId", "assetId");

-- CreateIndex
CREATE INDEX "AssetOdometerReset_assetId_idx" ON "AssetOdometerReset"("assetId");

-- CreateIndex
CREATE INDEX "AssetOdometerReset_companyId_idx" ON "AssetOdometerReset"("companyId");

-- CreateIndex
CREATE INDEX "AssetOdometerReset_createdByUserId_idx" ON "AssetOdometerReset"("createdByUserId");

-- CreateIndex
CREATE INDEX "AssetTransferRequest_companyId_idx" ON "AssetTransferRequest"("companyId");

-- CreateIndex
CREATE INDEX "AssetTransferRequest_assetId_idx" ON "AssetTransferRequest"("assetId");

-- CreateIndex
CREATE INDEX "AssetTransferRequest_fromProjectId_idx" ON "AssetTransferRequest"("fromProjectId");

-- CreateIndex
CREATE INDEX "AssetTransferRequest_toProjectId_idx" ON "AssetTransferRequest"("toProjectId");

-- CreateIndex
CREATE INDEX "AssetTransferRequest_requestedByUserId_idx" ON "AssetTransferRequest"("requestedByUserId");

-- CreateIndex
CREATE INDEX "AssetTransferRequest_status_idx" ON "AssetTransferRequest"("status");

-- CreateIndex
CREATE INDEX "AssetTransferApproval_transferRequestId_idx" ON "AssetTransferApproval"("transferRequestId");

-- CreateIndex
CREATE INDEX "AssetTransferApproval_approverUserId_idx" ON "AssetTransferApproval"("approverUserId");

-- CreateIndex
CREATE INDEX "AssetTransferApproval_projectId_idx" ON "AssetTransferApproval"("projectId");

-- CreateIndex
CREATE INDEX "AssetTransferApproval_status_idx" ON "AssetTransferApproval"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AssetTransferApproval_transferRequestId_approverUserId_proj_key" ON "AssetTransferApproval"("transferRequestId", "approverUserId", "projectId");

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetOdometerReset" ADD CONSTRAINT "AssetOdometerReset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetOdometerReset" ADD CONSTRAINT "AssetOdometerReset_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTransferRequest" ADD CONSTRAINT "AssetTransferRequest_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTransferRequest" ADD CONSTRAINT "AssetTransferRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTransferRequest" ADD CONSTRAINT "AssetTransferRequest_fromProjectId_fkey" FOREIGN KEY ("fromProjectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTransferRequest" ADD CONSTRAINT "AssetTransferRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTransferRequest" ADD CONSTRAINT "AssetTransferRequest_toProjectId_fkey" FOREIGN KEY ("toProjectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTransferApproval" ADD CONSTRAINT "AssetTransferApproval_approverUserId_fkey" FOREIGN KEY ("approverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTransferApproval" ADD CONSTRAINT "AssetTransferApproval_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTransferApproval" ADD CONSTRAINT "AssetTransferApproval_transferRequestId_fkey" FOREIGN KEY ("transferRequestId") REFERENCES "AssetTransferRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
