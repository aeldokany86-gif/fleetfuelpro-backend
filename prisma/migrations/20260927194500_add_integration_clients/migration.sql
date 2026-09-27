-- CreateEnum
CREATE TYPE "IntegrationClientStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "IntegrationClient" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "IntegrationClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "clientId" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "IntegrationClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationClientScope" (
    "id" TEXT NOT NULL,
    "integrationClientId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationClientScope_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationClient_clientId_key" ON "IntegrationClient"("clientId");

-- CreateIndex
CREATE INDEX "IntegrationClient_companyId_idx" ON "IntegrationClient"("companyId");

-- CreateIndex
CREATE INDEX "IntegrationClient_companyId_status_idx" ON "IntegrationClient"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationClient_companyId_name_key" ON "IntegrationClient"("companyId", "name");

-- CreateIndex
CREATE INDEX "IntegrationClientScope_integrationClientId_idx" ON "IntegrationClientScope"("integrationClientId");

-- CreateIndex
CREATE INDEX "IntegrationClientScope_scope_idx" ON "IntegrationClientScope"("scope");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationClientScope_integrationClientId_scope_key" ON "IntegrationClientScope"("integrationClientId", "scope");

-- AddForeignKey
ALTER TABLE "IntegrationClient" ADD CONSTRAINT "IntegrationClient_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationClientScope" ADD CONSTRAINT "IntegrationClientScope_integrationClientId_fkey" FOREIGN KEY ("integrationClientId") REFERENCES "IntegrationClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
