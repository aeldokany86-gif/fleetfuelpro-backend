-- CreateTable
CREATE TABLE "CompanyIntegrationSettings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "operationsSummaryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "operationsDetailsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "costDataEnabled" BOOLEAN NOT NULL DEFAULT false,
    "stockReadEnabled" BOOLEAN NOT NULL DEFAULT false,
    "stockMovementsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "webhooksEnabled" BOOLEAN NOT NULL DEFAULT false,
    "externalMappingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "externalMappingManualEnabled" BOOLEAN NOT NULL DEFAULT false,
    "externalMappingImportEnabled" BOOLEAN NOT NULL DEFAULT false,
    "clientLimit" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyIntegrationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyIntegrationWebhookEvent" (
    "id" TEXT NOT NULL,
    "companyIntegrationSettingsId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyIntegrationWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyIntegrationSettings_companyId_key" ON "CompanyIntegrationSettings"("companyId");

-- CreateIndex
CREATE INDEX "CompanyIntegrationSettings_enabled_idx" ON "CompanyIntegrationSettings"("enabled");

-- CreateIndex
CREATE INDEX "CompanyIntegrationWebhookEvent_companyIntegrationSettingsId_idx" ON "CompanyIntegrationWebhookEvent"("companyIntegrationSettingsId");

-- CreateIndex
CREATE INDEX "CompanyIntegrationWebhookEvent_eventType_idx" ON "CompanyIntegrationWebhookEvent"("eventType");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyIntegrationWebhookEvent_companyIntegrationSettingsId_key" ON "CompanyIntegrationWebhookEvent"("companyIntegrationSettingsId", "eventType");

-- AddForeignKey
ALTER TABLE "CompanyIntegrationSettings" ADD CONSTRAINT "CompanyIntegrationSettings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyIntegrationWebhookEvent" ADD CONSTRAINT "CompanyIntegrationWebhookEvent_companyIntegrationSettingsI_fkey" FOREIGN KEY ("companyIntegrationSettingsId") REFERENCES "CompanyIntegrationSettings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
