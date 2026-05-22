-- CreateEnum
CREATE TYPE "EmployeeTransferStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'APPLIED');

-- CreateEnum
CREATE TYPE "EmployeeTransferApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "projectManagerId" TEXT;

-- CreateTable
CREATE TABLE "EmployeeTransferRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
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

    CONSTRAINT "EmployeeTransferRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeTransferApproval" (
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

    CONSTRAINT "EmployeeTransferApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeTransferRequest_companyId_idx" ON "EmployeeTransferRequest"("companyId");

-- CreateIndex
CREATE INDEX "EmployeeTransferRequest_employeeId_idx" ON "EmployeeTransferRequest"("employeeId");

-- CreateIndex
CREATE INDEX "EmployeeTransferRequest_fromProjectId_idx" ON "EmployeeTransferRequest"("fromProjectId");

-- CreateIndex
CREATE INDEX "EmployeeTransferRequest_toProjectId_idx" ON "EmployeeTransferRequest"("toProjectId");

-- CreateIndex
CREATE INDEX "EmployeeTransferRequest_requestedByUserId_idx" ON "EmployeeTransferRequest"("requestedByUserId");

-- CreateIndex
CREATE INDEX "EmployeeTransferRequest_status_idx" ON "EmployeeTransferRequest"("status");

-- CreateIndex
CREATE INDEX "EmployeeTransferApproval_transferRequestId_idx" ON "EmployeeTransferApproval"("transferRequestId");

-- CreateIndex
CREATE INDEX "EmployeeTransferApproval_approverUserId_idx" ON "EmployeeTransferApproval"("approverUserId");

-- CreateIndex
CREATE INDEX "EmployeeTransferApproval_projectId_idx" ON "EmployeeTransferApproval"("projectId");

-- CreateIndex
CREATE INDEX "EmployeeTransferApproval_status_idx" ON "EmployeeTransferApproval"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeTransferApproval_transferRequestId_approverUserId_p_key" ON "EmployeeTransferApproval"("transferRequestId", "approverUserId", "projectId");

-- CreateIndex
CREATE INDEX "Project_companyId_idx" ON "Project"("companyId");

-- CreateIndex
CREATE INDEX "Project_projectManagerId_idx" ON "Project"("projectManagerId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_projectManagerId_fkey" FOREIGN KEY ("projectManagerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransferRequest" ADD CONSTRAINT "EmployeeTransferRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransferRequest" ADD CONSTRAINT "EmployeeTransferRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransferRequest" ADD CONSTRAINT "EmployeeTransferRequest_fromProjectId_fkey" FOREIGN KEY ("fromProjectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransferRequest" ADD CONSTRAINT "EmployeeTransferRequest_toProjectId_fkey" FOREIGN KEY ("toProjectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransferRequest" ADD CONSTRAINT "EmployeeTransferRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransferApproval" ADD CONSTRAINT "EmployeeTransferApproval_transferRequestId_fkey" FOREIGN KEY ("transferRequestId") REFERENCES "EmployeeTransferRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransferApproval" ADD CONSTRAINT "EmployeeTransferApproval_approverUserId_fkey" FOREIGN KEY ("approverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeTransferApproval" ADD CONSTRAINT "EmployeeTransferApproval_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
