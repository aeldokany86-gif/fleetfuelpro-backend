-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "currentFuelPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "fuelPriceCurrency" TEXT NOT NULL DEFAULT 'SAR',
ADD COLUMN     "fuelPriceEffectiveFrom" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ProjectFuelPriceHistory" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "country" TEXT,
    "currency" TEXT NOT NULL,
    "basePricePerLiter" DOUBLE PRECISION,
    "transportCost" DOUBLE PRECISION,
    "pricePerLiter" DOUBLE PRECISION NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectFuelPriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectFuelPriceHistory_projectId_idx" ON "ProjectFuelPriceHistory"("projectId");

-- CreateIndex
CREATE INDEX "ProjectFuelPriceHistory_companyId_idx" ON "ProjectFuelPriceHistory"("companyId");

-- CreateIndex
CREATE INDEX "ProjectFuelPriceHistory_country_idx" ON "ProjectFuelPriceHistory"("country");

-- CreateIndex
CREATE INDEX "ProjectFuelPriceHistory_effectiveFrom_idx" ON "ProjectFuelPriceHistory"("effectiveFrom");

-- AddForeignKey
ALTER TABLE "ProjectFuelPriceHistory" ADD CONSTRAINT "ProjectFuelPriceHistory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectFuelPriceHistory" ADD CONSTRAINT "ProjectFuelPriceHistory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectFuelPriceHistory" ADD CONSTRAINT "ProjectFuelPriceHistory_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
