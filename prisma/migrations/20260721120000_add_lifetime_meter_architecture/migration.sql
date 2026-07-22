-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "currentLifetimeOdometer" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "currentMeterCycle" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "AssetOdometerReset" ADD COLUMN     "lifetimeAtReset" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "newMeterCycle" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "oldMeterCycle" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Operation" ADD COLUMN     "assetMeterCycleNumber" INTEGER,
ADD COLUMN     "lifetimeCounter" DOUBLE PRECISION,
ADD COLUMN     "lifetimeOdometer" DOUBLE PRECISION,
ADD COLUMN     "stationCounterCycleNumber" INTEGER;

-- AlterTable
ALTER TABLE "Station" ADD COLUMN     "currentCounterCycle" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "currentLifetimeCounter" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "StationCounterReset" ADD COLUMN     "lifetimeAtReset" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "newCounterCycle" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "oldCounterCycle" INTEGER NOT NULL DEFAULT 1;

