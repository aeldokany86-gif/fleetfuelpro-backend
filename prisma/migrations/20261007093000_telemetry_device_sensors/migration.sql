-- Per-device telemetry sensor activation
CREATE TABLE "TelemetryDeviceSensor" (
  "id" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "sensorDefinitionId" TEXT NOT NULL,
  "isEnabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TelemetryDeviceSensor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TelemetryDeviceSensor_deviceId_sensorDefinitionId_key"
  ON "TelemetryDeviceSensor"("deviceId", "sensorDefinitionId");

CREATE INDEX "TelemetryDeviceSensor_deviceId_isEnabled_idx"
  ON "TelemetryDeviceSensor"("deviceId", "isEnabled");

CREATE INDEX "TelemetryDeviceSensor_sensorDefinitionId_idx"
  ON "TelemetryDeviceSensor"("sensorDefinitionId");

ALTER TABLE "TelemetryDeviceSensor"
  ADD CONSTRAINT "TelemetryDeviceSensor_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "TelemetryDevice"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TelemetryDeviceSensor"
  ADD CONSTRAINT "TelemetryDeviceSensor_sensorDefinitionId_fkey"
  FOREIGN KEY ("sensorDefinitionId") REFERENCES "TelemetrySensorDefinition"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
