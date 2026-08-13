-- Multi-Project Employee Access
-- Reconciliation migration for schema changes already applied manually to Supabase.

-- 1) Company feature flag
ALTER TABLE "Company"
ADD COLUMN IF NOT EXISTS "multiProjectEnabled" BOOLEAN NOT NULL DEFAULT false;

-- 2) Employee transfer behavior
ALTER TABLE "EmployeeTransferRequest"
ADD COLUMN IF NOT EXISTS "keepLinkedProjects" BOOLEAN NOT NULL DEFAULT true;

-- 3) Removal request status enum
DO $$
BEGIN
    CREATE TYPE "EmployeeProjectRemovalStatus" AS ENUM (
        'PENDING',
        'APPROVED',
        'REJECTED'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- 4) Additional employee-project assignments
CREATE TABLE IF NOT EXISTS "EmployeeProjectAssignment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "assignedByUserId" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeProjectAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS
"EmployeeProjectAssignment_employeeId_projectId_key"
ON "EmployeeProjectAssignment"("employeeId", "projectId");

CREATE INDEX IF NOT EXISTS
"EmployeeProjectAssignment_companyId_idx"
ON "EmployeeProjectAssignment"("companyId");

CREATE INDEX IF NOT EXISTS
"EmployeeProjectAssignment_employeeId_idx"
ON "EmployeeProjectAssignment"("employeeId");

CREATE INDEX IF NOT EXISTS
"EmployeeProjectAssignment_projectId_idx"
ON "EmployeeProjectAssignment"("projectId");

CREATE INDEX IF NOT EXISTS
"EmployeeProjectAssignment_assignedByUserId_idx"
ON "EmployeeProjectAssignment"("assignedByUserId");

DO $$
BEGIN
    ALTER TABLE "EmployeeProjectAssignment"
    ADD CONSTRAINT "EmployeeProjectAssignment_companyId_fkey"
    FOREIGN KEY ("companyId")
    REFERENCES "Company"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "EmployeeProjectAssignment"
    ADD CONSTRAINT "EmployeeProjectAssignment_employeeId_fkey"
    FOREIGN KEY ("employeeId")
    REFERENCES "Employee"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "EmployeeProjectAssignment"
    ADD CONSTRAINT "EmployeeProjectAssignment_projectId_fkey"
    FOREIGN KEY ("projectId")
    REFERENCES "Project"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "EmployeeProjectAssignment"
    ADD CONSTRAINT "EmployeeProjectAssignment_assignedByUserId_fkey"
    FOREIGN KEY ("assignedByUserId")
    REFERENCES "User"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- 5) Requests to remove linked projects after employee transfer
CREATE TABLE IF NOT EXISTS "EmployeeProjectRemovalRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "transferRequestId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "approverUserId" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "status" "EmployeeProjectRemovalStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "rejectionReason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeProjectRemovalRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS
"EmployeeProjectRemovalRequest_transferRequestId_employeeId_projectId_key"
ON "EmployeeProjectRemovalRequest"(
    "transferRequestId",
    "employeeId",
    "projectId"
);

CREATE INDEX IF NOT EXISTS
"EmployeeProjectRemovalRequest_companyId_idx"
ON "EmployeeProjectRemovalRequest"("companyId");

CREATE INDEX IF NOT EXISTS
"EmployeeProjectRemovalRequest_employeeId_idx"
ON "EmployeeProjectRemovalRequest"("employeeId");

CREATE INDEX IF NOT EXISTS
"EmployeeProjectRemovalRequest_projectId_idx"
ON "EmployeeProjectRemovalRequest"("projectId");

CREATE INDEX IF NOT EXISTS
"EmployeeProjectRemovalRequest_transferRequestId_idx"
ON "EmployeeProjectRemovalRequest"("transferRequestId");

CREATE INDEX IF NOT EXISTS
"EmployeeProjectRemovalRequest_requestedByUserId_idx"
ON "EmployeeProjectRemovalRequest"("requestedByUserId");

CREATE INDEX IF NOT EXISTS
"EmployeeProjectRemovalRequest_approverUserId_idx"
ON "EmployeeProjectRemovalRequest"("approverUserId");

CREATE INDEX IF NOT EXISTS
"EmployeeProjectRemovalRequest_status_idx"
ON "EmployeeProjectRemovalRequest"("status");

DO $$
BEGIN
    ALTER TABLE "EmployeeProjectRemovalRequest"
    ADD CONSTRAINT "EmployeeProjectRemovalRequest_companyId_fkey"
    FOREIGN KEY ("companyId")
    REFERENCES "Company"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "EmployeeProjectRemovalRequest"
    ADD CONSTRAINT "EmployeeProjectRemovalRequest_employeeId_fkey"
    FOREIGN KEY ("employeeId")
    REFERENCES "Employee"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "EmployeeProjectRemovalRequest"
    ADD CONSTRAINT "EmployeeProjectRemovalRequest_projectId_fkey"
    FOREIGN KEY ("projectId")
    REFERENCES "Project"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "EmployeeProjectRemovalRequest"
    ADD CONSTRAINT "EmployeeProjectRemovalRequest_transferRequestId_fkey"
    FOREIGN KEY ("transferRequestId")
    REFERENCES "EmployeeTransferRequest"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "EmployeeProjectRemovalRequest"
    ADD CONSTRAINT "EmployeeProjectRemovalRequest_requestedByUserId_fkey"
    FOREIGN KEY ("requestedByUserId")
    REFERENCES "User"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "EmployeeProjectRemovalRequest"
    ADD CONSTRAINT "EmployeeProjectRemovalRequest_approverUserId_fkey"
    FOREIGN KEY ("approverUserId")
    REFERENCES "User"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "EmployeeProjectRemovalRequest"
    ADD CONSTRAINT "EmployeeProjectRemovalRequest_reviewedByUserId_fkey"
    FOREIGN KEY ("reviewedByUserId")
    REFERENCES "User"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
