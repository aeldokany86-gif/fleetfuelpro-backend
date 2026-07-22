const { PrismaClient } = require("@prisma/client");

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is missing.");
}

const separator = databaseUrl.includes("?") ? "&" : "?";

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: `${databaseUrl}${separator}pgbouncer=true&connection_limit=1`,
    },
  },
});

const APPLY_CHANGES =
  String(process.env.APPLY_CHANGES || "false").trim().toLowerCase() === "true";

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function eventTime(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sortEvents(a, b) {
  const effectiveDifference = eventTime(a.at) - eventTime(b.at);
  if (effectiveDifference !== 0) return effectiveDifference;

  const createdDifference =
    eventTime(a.createdAt) - eventTime(b.createdAt);
  if (createdDifference !== 0) return createdDifference;

  // A reset effective at the same instant starts the new cycle first.
  if (a.kind !== b.kind) return a.kind === "RESET" ? -1 : 1;

  return String(a.item.id).localeCompare(String(b.item.id));
}

function buildAssetHistory(asset, operations, resets) {
  const events = [
    ...operations.map((operation) => ({
      kind: "OPERATION",
      at: operation.createdAt,
      createdAt: operation.createdAt,
      item: operation,
    })),
    ...resets.map((reset) => ({
      kind: "RESET",
      at: reset.effectiveAt,
      createdAt: reset.createdAt,
      item: reset,
    })),
  ].sort(sortEvents);

  let cycleNumber = 1;
  let lifetimeOdometer = null;
  let previousReading = null;
  let latestReading = toNumber(asset.currentOdometer);
  let lastEventKind = null;

  const operationUpdates = [];
  const resetUpdates = [];

  for (const event of events) {
    if (event.kind === "RESET") {
      const oldReading = toNumber(event.item.oldOdometer);
      const newReading = toNumber(event.item.newOdometer);
      const oldMeterCycle = cycleNumber;
      const newMeterCycle = oldMeterCycle + 1;

      if (lifetimeOdometer === null) {
        lifetimeOdometer = oldReading;
      }

      resetUpdates.push({
        id: event.item.id,
        oldOdometer: oldReading,
        newOdometer: newReading,
        lifetimeAtReset: lifetimeOdometer,
        oldMeterCycle,
        newMeterCycle,
      });

      cycleNumber = newMeterCycle;
      previousReading = newReading;
      latestReading = newReading;
      lastEventKind = "RESET";
      continue;
    }

    const reading = Number(event.item.odometer);

    if (!Number.isFinite(reading) || reading < 0) {
      throw new Error(
        `${event.item.operationNo || event.item.id}: invalid odometer ${event.item.odometer}`
      );
    }

    if (previousReading === null) {
      // First known physical reading anchors the absolute lifetime.
      lifetimeOdometer = reading;
      previousReading = reading;
    } else {
      if (reading < previousReading) {
        throw new Error(
          `${event.item.operationNo || event.item.id}: odometer ${reading} is lower than previous reading ${previousReading} in cycle ${cycleNumber}. A reset/correction may be missing.`
        );
      }

      lifetimeOdometer =
        toNumber(lifetimeOdometer) + (reading - previousReading);
      previousReading = reading;
    }

    latestReading = reading;
    lastEventKind = "OPERATION";

    operationUpdates.push({
      id: event.item.id,
      operationNo: event.item.operationNo,
      odometer: reading,
      lifetimeOdometer,
      assetMeterCycleNumber: cycleNumber,
    });
  }

  if (events.length === 0) {
    lifetimeOdometer = toNumber(
      asset.currentLifetimeOdometer,
      toNumber(asset.currentOdometer)
    );

    if (lifetimeOdometer === 0 && toNumber(asset.currentOdometer) !== 0) {
      lifetimeOdometer = toNumber(asset.currentOdometer);
    }

    cycleNumber = toNumber(asset.currentMeterCycle, 1) || 1;
  }

  return {
    operationUpdates,
    resetUpdates,
    assetUpdate: {
      currentOdometer: latestReading,
      currentLifetimeOdometer: toNumber(lifetimeOdometer),
      currentMeterCycle: cycleNumber,
    },
    lastEventKind,
  };
}

async function loadAssets() {
  return prisma.asset.findMany({
    where: {
      deletedAt: null,
    },
    orderBy: [{ companyId: "asc" }, { assetId: "asc" }],
    select: {
      id: true,
      assetId: true,
      companyId: true,
      currentOdometer: true,
      currentLifetimeOdometer: true,
      currentMeterCycle: true,
    },
  });
}

async function processAsset(asset) {
  const [operations, resets] = await Promise.all([
    prisma.operation.findMany({
      where: {
        assetId: asset.id,
        status: "COMPLETED",
        odometer: { not: null },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        operationNo: true,
        odometer: true,
        createdAt: true,
      },
    }),
    prisma.assetOdometerReset.findMany({
      where: { assetId: asset.id },
      orderBy: [{ effectiveAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        oldOdometer: true,
        newOdometer: true,
        effectiveAt: true,
        createdAt: true,
      },
    }),
  ]);

  const rebuilt = buildAssetHistory(asset, operations, resets);

  if (!APPLY_CHANGES) {
    return {
      assetId: asset.assetId,
      backendId: asset.id,
      operations: operations.length,
      resets: resets.length,
      before: {
        currentOdometer: asset.currentOdometer,
        currentLifetimeOdometer: asset.currentLifetimeOdometer,
        currentMeterCycle: asset.currentMeterCycle,
      },
      after: rebuilt.assetUpdate,
    };
  }

  await prisma.$transaction(
    async (tx) => {
      for (const update of rebuilt.operationUpdates) {
        await tx.operation.update({
          where: { id: update.id },
          data: {
            lifetimeOdometer: update.lifetimeOdometer,
            assetMeterCycleNumber: update.assetMeterCycleNumber,
          },
        });
      }

      for (const update of rebuilt.resetUpdates) {
        await tx.assetOdometerReset.update({
          where: { id: update.id },
          data: {
            lifetimeAtReset: update.lifetimeAtReset,
            oldMeterCycle: update.oldMeterCycle,
            newMeterCycle: update.newMeterCycle,
          },
        });
      }

      await tx.asset.update({
        where: { id: asset.id },
        data: rebuilt.assetUpdate,
      });
    },
    {
      maxWait: 10000,
      timeout: 60000,
    }
  );

  return {
    assetId: asset.assetId,
    backendId: asset.id,
    operations: operations.length,
    resets: resets.length,
    before: {
      currentOdometer: asset.currentOdometer,
      currentLifetimeOdometer: asset.currentLifetimeOdometer,
      currentMeterCycle: asset.currentMeterCycle,
    },
    after: rebuilt.assetUpdate,
  };
}

async function main() {
  console.log(
    APPLY_CHANGES
      ? "APPLY MODE: database values will be updated."
      : "DRY RUN: no database values will be changed."
  );

  const assets = await loadAssets();
  const successful = [];
  const failed = [];

  for (const asset of assets) {
    try {
      const result = await processAsset(asset);
      successful.push(result);

      console.log(
        `[OK] ${result.assetId}: operations=${result.operations}, resets=${result.resets}, lifetime ${result.before.currentLifetimeOdometer} -> ${result.after.currentLifetimeOdometer}, cycle ${result.before.currentMeterCycle} -> ${result.after.currentMeterCycle}`
      );
    } catch (error) {
      const failure = {
        assetId: asset.assetId,
        backendId: asset.id,
        error: error instanceof Error ? error.message : String(error),
      };

      failed.push(failure);
      console.error(`[SKIPPED] ${failure.assetId}: ${failure.error}`);
    }
  }

  console.log("\nSUMMARY");
  console.log(
    JSON.stringify(
      {
        mode: APPLY_CHANGES ? "APPLY" : "DRY_RUN",
        totalAssets: assets.length,
        successfulAssets: successful.length,
        skippedAssets: failed.length,
        failed,
      },
      null,
      2
    )
  );

  if (failed.length > 0) {
    process.exitCode = 2;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
