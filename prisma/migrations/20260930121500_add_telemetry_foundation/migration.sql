-- CreateEnum
CREATE TYPE "TelemetryDeviceStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'OFFLINE', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "TelemetryTransport" AS ENUM ('MQTT', 'TCP', 'UDP', 'HTTP', 'HTTPS', 'OTHER');

-- CreateEnum
CREATE TYPE "TelemetryDataSource" AS ENUM ('ECU_CAN', 'GNSS', 'DEVICE', 'EXTERNAL_SENSOR', 'CALCULATED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TelemetryParseStatus" AS ENUM ('RECEIVED', 'PARSED', 'PARTIALLY_PARSED', 'FAILED');

-- CreateTable
CREATE TABLE "TelemetryDevice" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT,
    "vendor" TEXT NOT NULL,
    "model" TEXT,
    "hardwareId" TEXT NOT NULL,
    "protocol" TEXT,
    "transport" "TelemetryTransport",
    "status" "TelemetryDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "firmwareVersion" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "TelemetryDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetryRawMessage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "deviceId" TEXT,
    "transport" "TelemetryTransport" NOT NULL,
    "topic" TEXT,
    "payload" BYTEA NOT NULL,
    "protocolVersion" TEXT,
    "parseStatus" "TelemetryParseStatus" NOT NULL DEFAULT 'RECEIVED',
    "checksumValid" BOOLEAN,
    "readingAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "parseError" TEXT,
    "metadata" JSONB,

    CONSTRAINT "TelemetryRawMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetrySensorDefinition" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "vendor" TEXT NOT NULL,
    "protocol" TEXT,
    "vendorSensorId" TEXT NOT NULL,
    "parameterCode" TEXT NOT NULL,
    "displayName" TEXT,
    "unit" TEXT,
    "multiplier" DOUBLE PRECISION,
    "offset" DOUBLE PRECISION,
    "dataSource" "TelemetryDataSource" NOT NULL DEFAULT 'UNKNOWN',
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelemetrySensorDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetTelemetryReading" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "rawMessageId" TEXT,
    "sensorDefinitionId" TEXT,
    "vendorSensorId" TEXT NOT NULL,
    "parameterCode" TEXT NOT NULL,
    "rawValue" JSONB,
    "numericValue" DOUBLE PRECISION,
    "textValue" TEXT,
    "jsonValue" JSONB,
    "unit" TEXT,
    "dataSource" "TelemetryDataSource" NOT NULL DEFAULT 'UNKNOWN',
    "readingAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "AssetTelemetryReading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelemetryDevice_companyId_idx" ON "TelemetryDevice"("companyId");

-- CreateIndex
CREATE INDEX "TelemetryDevice_assetId_idx" ON "TelemetryDevice"("assetId");

-- CreateIndex
CREATE INDEX "TelemetryDevice_companyId_status_idx" ON "TelemetryDevice"("companyId", "status");

-- CreateIndex
CREATE INDEX "TelemetryDevice_lastSeenAt_idx" ON "TelemetryDevice"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelemetryDevice_vendor_hardwareId_key" ON "TelemetryDevice"("vendor", "hardwareId");

-- CreateIndex
CREATE INDEX "TelemetryRawMessage_companyId_receivedAt_idx" ON "TelemetryRawMessage"("companyId", "receivedAt");

-- CreateIndex
CREATE INDEX "TelemetryRawMessage_deviceId_receivedAt_idx" ON "TelemetryRawMessage"("deviceId", "receivedAt");

-- CreateIndex
CREATE INDEX "TelemetryRawMessage_parseStatus_idx" ON "TelemetryRawMessage"("parseStatus");

-- CreateIndex
CREATE INDEX "TelemetrySensorDefinition_vendor_vendorSensorId_idx" ON "TelemetrySensorDefinition"("vendor", "vendorSensorId");

-- CreateIndex
CREATE INDEX "TelemetrySensorDefinition_parameterCode_idx" ON "TelemetrySensorDefinition"("parameterCode");

-- CreateIndex
CREATE INDEX "TelemetrySensorDefinition_companyId_idx" ON "TelemetrySensorDefinition"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "TelemetrySensorDefinition_companyId_vendor_protocol_vendorS_key" ON "TelemetrySensorDefinition"("companyId", "vendor", "protocol", "vendorSensorId");

-- CreateIndex
CREATE INDEX "AssetTelemetryReading_companyId_readingAt_idx" ON "AssetTelemetryReading"("companyId", "readingAt");

-- CreateIndex
CREATE INDEX "AssetTelemetryReading_assetId_parameterCode_readingAt_idx" ON "AssetTelemetryReading"("assetId", "parameterCode", "readingAt");

-- CreateIndex
CREATE INDEX "AssetTelemetryReading_deviceId_readingAt_idx" ON "AssetTelemetryReading"("deviceId", "readingAt");

-- CreateIndex
CREATE INDEX "AssetTelemetryReading_rawMessageId_idx" ON "AssetTelemetryReading"("rawMessageId");

-- CreateIndex
CREATE INDEX "AssetTelemetryReading_sensorDefinitionId_idx" ON "AssetTelemetryReading"("sensorDefinitionId");

-- AddForeignKey
ALTER TABLE "TelemetryDevice" ADD CONSTRAINT "TelemetryDevice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryDevice" ADD CONSTRAINT "TelemetryDevice_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryRawMessage" ADD CONSTRAINT "TelemetryRawMessage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryRawMessage" ADD CONSTRAINT "TelemetryRawMessage_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "TelemetryDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetrySensorDefinition" ADD CONSTRAINT "TelemetrySensorDefinition_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTelemetryReading" ADD CONSTRAINT "AssetTelemetryReading_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTelemetryReading" ADD CONSTRAINT "AssetTelemetryReading_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTelemetryReading" ADD CONSTRAINT "AssetTelemetryReading_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "TelemetryDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTelemetryReading" ADD CONSTRAINT "AssetTelemetryReading_rawMessageId_fkey" FOREIGN KEY ("rawMessageId") REFERENCES "TelemetryRawMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTelemetryReading" ADD CONSTRAINT "AssetTelemetryReading_sensorDefinitionId_fkey" FOREIGN KEY ("sensorDefinitionId") REFERENCES "TelemetrySensorDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
