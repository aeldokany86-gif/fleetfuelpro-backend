-- Stage 1: persist station opening counter and prepare immutable operation counter snapshots.
-- Existing Station rows intentionally receive NULL openingCounter until the verified
-- historical values are backfilled. New station creation will populate it explicitly.

ALTER TABLE "Station"
ADD COLUMN IF NOT EXISTS "openingCounter" DOUBLE PRECISION;

ALTER TABLE "OperationStationCounterReading"
ADD COLUMN IF NOT EXISTS "counterBefore" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "counterAfter" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "lifetimeBefore" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "lifetimeAfter" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "counterCycleBefore" INTEGER,
ADD COLUMN IF NOT EXISTS "counterCycleAfter" INTEGER;
