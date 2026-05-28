-- CreateEnum
CREATE TYPE "StationAssignmentType" AS ENUM ('INITIAL_ASSIGNMENT', 'TRANSFER');

-- CreateEnum
CREATE TYPE "StationStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "StationStockMovementType" AS ENUM ('OPENING_BALANCE', 'ADJUSTMENT', 'ZERO_BALANCE', 'DIRECT_REFUEL_OUT', 'INTERNAL_TRANSFER_IN', 'INTERNAL_TRANSFER_OUT', 'EXTERNAL_SUPPLY_IN', 'EXTERNAL_TRANSFER_IN', 'EXTERNAL_TRANSFER_OUT', 'COUNTER_CORRECTION');

-- CreateEnum
CREATE TYPE "StationTransferStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'APPLIED', 'PARTIALLY_APPROVED');

-- CreateEnum
CREATE TYPE "StationTransferApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "Station" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "name" TEXT,
    "type" TEXT,
    "capacity" DOUBLE PRECISION,
    "openingBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currentStock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currentCounter" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "StationStatus" NOT NULL DEFAULT 'ACTIVE',
    "projectId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Station_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationCounterReset" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "oldCounter" DOUBLE PRECISION NOT NULL,
    "newCounter" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationCounterReset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationStockMovement" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "movementType" "StationStockMovementType" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "balanceBefore" DOUBLE PRECISION NOT NULL,
    "balanceAfter" DOUBLE PRECISION NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "reason" TEXT,
    "movementAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationStockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationPriceHistory" (
    "id" TEXT NOT NULL,
    "stationId" TEXT,
    "companyId" TEXT NOT NULL,
    "country" TEXT,
    "currency" TEXT NOT NULL,
    "pricePerLiter" DOUBLE PRECISION NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationPriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationTransferRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "fromProjectId" TEXT NOT NULL,
    "toProjectId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "status" "StationTransferStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "rejectionReason" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StationTransferRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationTransferApproval" (
    "id" TEXT NOT NULL,
    "transferRequestId" TEXT NOT NULL,
    "approverUserId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "approvalStage" TEXT NOT NULL,
    "status" "StationTransferApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StationTransferApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationAssignmentHistory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "fromProjectId" TEXT,
    "toProjectId" TEXT NOT NULL,
    "transferRequestId" TEXT,
    "assignmentType" "StationAssignmentType" NOT NULL,
    "reason" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationAssignmentHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Station_companyId_idx" ON "Station"("companyId");

-- CreateIndex
CREATE INDEX "Station_projectId_idx" ON "Station"("projectId");

-- CreateIndex
CREATE INDEX "Station_status_idx" ON "Station"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Station_companyId_stationId_key" ON "Station"("companyId", "stationId");

-- CreateIndex
CREATE INDEX "StationCounterReset_stationId_idx" ON "StationCounterReset"("stationId");

-- CreateIndex
CREATE INDEX "StationCounterReset_companyId_idx" ON "StationCounterReset"("companyId");

-- CreateIndex
CREATE INDEX "StationCounterReset_createdByUserId_idx" ON "StationCounterReset"("createdByUserId");

-- CreateIndex
CREATE INDEX "StationStockMovement_stationId_idx" ON "StationStockMovement"("stationId");

-- CreateIndex
CREATE INDEX "StationStockMovement_companyId_idx" ON "StationStockMovement"("companyId");

-- CreateIndex
CREATE INDEX "StationStockMovement_movementType_idx" ON "StationStockMovement"("movementType");

-- CreateIndex
CREATE INDEX "StationStockMovement_movementAt_idx" ON "StationStockMovement"("movementAt");

-- CreateIndex
CREATE INDEX "StationStockMovement_referenceType_referenceId_idx" ON "StationStockMovement"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "StationPriceHistory_stationId_idx" ON "StationPriceHistory"("stationId");

-- CreateIndex
CREATE INDEX "StationPriceHistory_companyId_idx" ON "StationPriceHistory"("companyId");

-- CreateIndex
CREATE INDEX "StationPriceHistory_country_idx" ON "StationPriceHistory"("country");

-- CreateIndex
CREATE INDEX "StationPriceHistory_effectiveFrom_idx" ON "StationPriceHistory"("effectiveFrom");

-- CreateIndex
CREATE INDEX "StationTransferRequest_companyId_idx" ON "StationTransferRequest"("companyId");

-- CreateIndex
CREATE INDEX "StationTransferRequest_stationId_idx" ON "StationTransferRequest"("stationId");

-- CreateIndex
CREATE INDEX "StationTransferRequest_fromProjectId_idx" ON "StationTransferRequest"("fromProjectId");

-- CreateIndex
CREATE INDEX "StationTransferRequest_toProjectId_idx" ON "StationTransferRequest"("toProjectId");

-- CreateIndex
CREATE INDEX "StationTransferRequest_requestedByUserId_idx" ON "StationTransferRequest"("requestedByUserId");

-- CreateIndex
CREATE INDEX "StationTransferRequest_status_idx" ON "StationTransferRequest"("status");

-- CreateIndex
CREATE INDEX "StationTransferApproval_transferRequestId_idx" ON "StationTransferApproval"("transferRequestId");

-- CreateIndex
CREATE INDEX "StationTransferApproval_approverUserId_idx" ON "StationTransferApproval"("approverUserId");

-- CreateIndex
CREATE INDEX "StationTransferApproval_projectId_idx" ON "StationTransferApproval"("projectId");

-- CreateIndex
CREATE INDEX "StationTransferApproval_status_idx" ON "StationTransferApproval"("status");

-- CreateIndex
CREATE UNIQUE INDEX "StationTransferApproval_transferRequestId_approverUserId_pr_key" ON "StationTransferApproval"("transferRequestId", "approverUserId", "projectId");

-- CreateIndex
CREATE INDEX "StationAssignmentHistory_companyId_idx" ON "StationAssignmentHistory"("companyId");

-- CreateIndex
CREATE INDEX "StationAssignmentHistory_stationId_idx" ON "StationAssignmentHistory"("stationId");

-- CreateIndex
CREATE INDEX "StationAssignmentHistory_fromProjectId_idx" ON "StationAssignmentHistory"("fromProjectId");

-- CreateIndex
CREATE INDEX "StationAssignmentHistory_toProjectId_idx" ON "StationAssignmentHistory"("toProjectId");

-- CreateIndex
CREATE INDEX "StationAssignmentHistory_transferRequestId_idx" ON "StationAssignmentHistory"("transferRequestId");

-- CreateIndex
CREATE INDEX "StationAssignmentHistory_assignedByUserId_idx" ON "StationAssignmentHistory"("assignedByUserId");

-- CreateIndex
CREATE INDEX "StationAssignmentHistory_assignedAt_idx" ON "StationAssignmentHistory"("assignedAt");

-- AddForeignKey
ALTER TABLE "Station" ADD CONSTRAINT "Station_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Station" ADD CONSTRAINT "Station_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Station" ADD CONSTRAINT "Station_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationCounterReset" ADD CONSTRAINT "StationCounterReset_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationCounterReset" ADD CONSTRAINT "StationCounterReset_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStockMovement" ADD CONSTRAINT "StationStockMovement_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStockMovement" ADD CONSTRAINT "StationStockMovement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStockMovement" ADD CONSTRAINT "StationStockMovement_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationPriceHistory" ADD CONSTRAINT "StationPriceHistory_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationPriceHistory" ADD CONSTRAINT "StationPriceHistory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationPriceHistory" ADD CONSTRAINT "StationPriceHistory_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationTransferRequest" ADD CONSTRAINT "StationTransferRequest_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationTransferRequest" ADD CONSTRAINT "StationTransferRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationTransferRequest" ADD CONSTRAINT "StationTransferRequest_fromProjectId_fkey" FOREIGN KEY ("fromProjectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationTransferRequest" ADD CONSTRAINT "StationTransferRequest_toProjectId_fkey" FOREIGN KEY ("toProjectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationTransferRequest" ADD CONSTRAINT "StationTransferRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationTransferApproval" ADD CONSTRAINT "StationTransferApproval_approverUserId_fkey" FOREIGN KEY ("approverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationTransferApproval" ADD CONSTRAINT "StationTransferApproval_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationTransferApproval" ADD CONSTRAINT "StationTransferApproval_transferRequestId_fkey" FOREIGN KEY ("transferRequestId") REFERENCES "StationTransferRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationAssignmentHistory" ADD CONSTRAINT "StationAssignmentHistory_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationAssignmentHistory" ADD CONSTRAINT "StationAssignmentHistory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationAssignmentHistory" ADD CONSTRAINT "StationAssignmentHistory_fromProjectId_fkey" FOREIGN KEY ("fromProjectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationAssignmentHistory" ADD CONSTRAINT "StationAssignmentHistory_toProjectId_fkey" FOREIGN KEY ("toProjectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationAssignmentHistory" ADD CONSTRAINT "StationAssignmentHistory_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationAssignmentHistory" ADD CONSTRAINT "StationAssignmentHistory_transferRequestId_fkey" FOREIGN KEY ("transferRequestId") REFERENCES "StationTransferRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
