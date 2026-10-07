-- Telemetry latest-snapshot performance index
-- Supports DISTINCT ON latest-reading lookup per device + sensor definition.

CREATE INDEX IF NOT EXISTS "telemetry_reading_device_sensor_time_idx"
ON "AssetTelemetryReading"(
  "deviceId",
  "sensorDefinitionId",
  "readingAt",
  "receivedAt"
);
