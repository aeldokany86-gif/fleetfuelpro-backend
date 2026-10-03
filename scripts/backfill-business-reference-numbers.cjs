const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const pad = (n) => String(n).padStart(6, '0');
const parseRef = (value, prefix) => {
  const match = new RegExp(`^${prefix}-(\\d+)$`, 'i').exec(String(value || '').trim());
  return match ? Number(match[1]) : 0;
};

async function backfillCorrections(companyId) {
  const rows = await prisma.operationCorrection.findMany({
    where: { companyId },
    select: { id: true, referenceNo: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  let next = Math.max(0, ...rows.map((row) => parseRef(row.referenceNo, 'CR'))) + 1;

  for (const row of rows) {
    if (row.referenceNo) continue;
    const referenceNo = `CR-${pad(next++)}`;
    await prisma.operationCorrection.update({
      where: { id: row.id },
      data: { referenceNo },
    });
  }

  await prisma.businessSequence.upsert({
    where: { companyId_key: { companyId, key: 'OPERATION_CORRECTION' } },
    create: { companyId, key: 'OPERATION_CORRECTION', nextValue: next },
    update: { nextValue: next },
  });

  return rows.length;
}

async function backfillStockAdjustments(companyId) {
  const requests = await prisma.stationActionRequest.findMany({
    where: {
      companyId,
      actionType: { in: ['INVENTORY_ADJUSTMENT', 'ZERO_BALANCE'] },
    },
    select: {
      id: true,
      referenceNo: true,
      createdAt: true,
    },
  });

  const movements = await prisma.stationStockMovement.findMany({
    where: {
      companyId,
      movementType: { in: ['PHYSICAL_ADJUSTMENT', 'ZERO_BALANCE'] },
    },
    select: {
      id: true,
      referenceNo: true,
      referenceType: true,
      referenceId: true,
      movementAt: true,
      createdAt: true,
    },
  });

  const requestById = new Map(requests.map((r) => [r.id, r]));

  // If one side of an old request/movement pair already has a reference, copy it
  // to the other side before allocating any new number.
  for (const movement of movements) {
    if (
      movement.referenceType === 'STATION_ACTION_REQUEST' &&
      movement.referenceId &&
      requestById.has(movement.referenceId)
    ) {
      const request = requestById.get(movement.referenceId);
      if (request.referenceNo && !movement.referenceNo) {
        await prisma.stationStockMovement.update({
          where: { id: movement.id },
          data: { referenceNo: request.referenceNo },
        });
        movement.referenceNo = request.referenceNo;
      } else if (!request.referenceNo && movement.referenceNo) {
        await prisma.stationActionRequest.update({
          where: { id: request.id },
          data: { referenceNo: movement.referenceNo },
        });
        request.referenceNo = movement.referenceNo;
      }
    }
  }

  let next =
    Math.max(
      0,
      ...requests.map((r) => parseRef(r.referenceNo, 'SA')),
      ...movements.map((m) => parseRef(m.referenceNo, 'SA')),
    ) + 1;

  const linkedMovementIds = new Set();
  for (const movement of movements) {
    if (
      movement.referenceType === 'STATION_ACTION_REQUEST' &&
      movement.referenceId &&
      requestById.has(movement.referenceId)
    ) {
      linkedMovementIds.add(movement.id);
    }
  }

  const events = [
    ...requests
      .filter((r) => !r.referenceNo)
      .map((r) => ({
        kind: 'request',
        id: r.id,
        at: r.createdAt,
      })),
    ...movements
      .filter((m) => !m.referenceNo && !linkedMovementIds.has(m.id))
      .map((m) => ({
        kind: 'movement',
        id: m.id,
        at: m.movementAt || m.createdAt,
      })),
  ].sort((a, b) => {
    const d = new Date(a.at).getTime() - new Date(b.at).getTime();
    return d || a.id.localeCompare(b.id);
  });

  for (const event of events) {
    const referenceNo = `SA-${pad(next++)}`;

    if (event.kind === 'request') {
      await prisma.stationActionRequest.update({
        where: { id: event.id },
        data: { referenceNo },
      });

      await prisma.stationStockMovement.updateMany({
        where: {
          companyId,
          referenceType: 'STATION_ACTION_REQUEST',
          referenceId: event.id,
          movementType: { in: ['PHYSICAL_ADJUSTMENT', 'ZERO_BALANCE'] },
          referenceNo: null,
        },
        data: { referenceNo },
      });
    } else {
      await prisma.stationStockMovement.update({
        where: { id: event.id },
        data: { referenceNo },
      });
    }
  }

  await prisma.businessSequence.upsert({
    where: { companyId_key: { companyId, key: 'STOCK_ADJUSTMENT' } },
    create: { companyId, key: 'STOCK_ADJUSTMENT', nextValue: next },
    update: { nextValue: next },
  });

  return {
    requests: requests.length,
    movements: movements.length,
  };
}

async function main() {
  const companyIds = Array.from(
    new Set([
      ...(await prisma.operationCorrection.findMany({
        distinct: ['companyId'],
        select: { companyId: true },
      })).map((x) => x.companyId),
      ...(await prisma.stationActionRequest.findMany({
        distinct: ['companyId'],
        select: { companyId: true },
      })).map((x) => x.companyId),
      ...(await prisma.stationStockMovement.findMany({
        distinct: ['companyId'],
        select: { companyId: true },
      })).map((x) => x.companyId),
    ]),
  ).filter(Boolean);

  for (const companyId of companyIds) {
    const correctionCount = await backfillCorrections(companyId);
    const stockCounts = await backfillStockAdjustments(companyId);
    console.log(
      `[${companyId}] CR rows=${correctionCount}, SA requests=${stockCounts.requests}, SA movements=${stockCounts.movements}`,
    );
  }

  console.log('Business reference backfill completed.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
