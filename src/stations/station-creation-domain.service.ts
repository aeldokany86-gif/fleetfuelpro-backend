import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Prisma,
  StationAssignmentType,
  StationStatus,
  StationStockMovementType,
} from '@prisma/client';

type StationCreationDb = Prisma.TransactionClient;

export type CreateStationDomainInput = {
  companyId: string;
  stationId: string;
  name?: string | null;
  type?: string | null;
  capacity?: number | null;
  openingBalance?: number | null;
  currentCounter?: number | null;
  projectId?: string | null;
  status?: string | StationStatus | null;
  createdById?: string | null;
};

@Injectable()
export class StationCreationDomainService {
  normalizeStationId(stationId: string) {
    return String(stationId || '').trim().toUpperCase();
  }

  normalizeProjectCode(projectCode: string) {
    return String(projectCode || '').trim().toUpperCase();
  }

  normalizeOptionalText(value?: string | null) {
    const normalized = String(value ?? '').trim();
    return normalized || null;
  }

  mapStationStatus(status?: string | StationStatus | null): StationStatus {
    const normalized = String(status || 'ACTIVE')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');

    return normalized === 'INACTIVE'
      ? StationStatus.INACTIVE
      : StationStatus.ACTIVE;
  }

  normalizeOpeningBalance(value?: number | null) {
    const openingBalance = Number(value ?? 0);

    if (!Number.isFinite(openingBalance) || openingBalance < 0) {
      throw new BadRequestException(
        'Opening balance must be a valid zero or positive number',
      );
    }

    return openingBalance;
  }

  normalizeCurrentCounter(value?: number | null) {
    const currentCounter = Number(value ?? 0);

    if (!Number.isFinite(currentCounter) || currentCounter < 0) {
      throw new BadRequestException(
        'Station counter must be a valid zero or positive number',
      );
    }

    return currentCounter;
  }

  normalizeCapacity(value?: number | null) {
    if (value === undefined || value === null) {
      return null;
    }

    const capacity = Number(value);

    if (!Number.isFinite(capacity)) {
      throw new BadRequestException('Station capacity must be a valid number');
    }

    return capacity;
  }

  async createStation(
    db: StationCreationDb,
    input: CreateStationDomainInput,
  ) {
    const stationId = this.normalizeStationId(input.stationId);

    if (!stationId) {
      throw new BadRequestException('Station ID is required');
    }

    const openingBalance = this.normalizeOpeningBalance(input.openingBalance);
    const currentCounter = this.normalizeCurrentCounter(input.currentCounter);
    const capacity = this.normalizeCapacity(input.capacity);

    const createdStation = await db.station.create({
      data: {
        companyId: input.companyId,
        stationId,
        name: this.normalizeOptionalText(input.name),
        type: this.normalizeOptionalText(input.type),
        capacity,
        openingBalance,
        currentStock: openingBalance,
        currentCounter,
        currentLifetimeCounter: currentCounter,
        currentCounterCycle: 1,
        projectId: input.projectId || null,
        status: this.mapStationStatus(input.status),
        createdById: input.createdById || null,
      },
      include: {
        company: true,
        project: true,
      },
    });

    await db.stationStockMovement.create({
      data: {
        companyId: input.companyId,
        stationId: createdStation.id,
        movementType: StationStockMovementType.OPENING_BALANCE,
        quantity: openingBalance,
        balanceBefore: 0,
        balanceAfter: openingBalance,
        referenceType: 'STATION_CREATE',
        referenceId: createdStation.id,
        reason: 'Initial station opening balance',
        createdByUserId: input.createdById || null,
      },
    });

    if (input.projectId) {
      await db.stationAssignmentHistory.create({
        data: {
          companyId: input.companyId,
          stationId: createdStation.id,
          fromProjectId: null,
          toProjectId: input.projectId,
          transferRequestId: null,
          assignmentType: StationAssignmentType.INITIAL_ASSIGNMENT,
          reason: 'Initial station project assignment',
          assignedAt: new Date(),
          assignedByUserId: input.createdById || null,
        },
      });
    }

    return createdStation;
  }
}
