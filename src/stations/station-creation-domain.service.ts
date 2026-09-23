import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Prisma,
  StationAssignmentType,
  StationStatus,
  StationStockMovementType,
  StationStructureType,
} from '@prisma/client';

type StationCreationDb = Prisma.TransactionClient;

export type CreateStationDomainInput = {
  companyId: string;
  stationId: string;
  name?: string | null;
  type?: string | null;
  structureType?: string | StationStructureType | null;
  parentStationId?: string | null;
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

  mapStructureType(
    structureType?: string | StationStructureType | null,
  ): StationStructureType {
    const normalized = String(structureType || 'STANDALONE')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');

    if (normalized === 'SHARED_TANK') {
      return StationStructureType.SHARED_TANK;
    }

    if (normalized === 'DISPENSER') {
      return StationStructureType.DISPENSER;
    }

    if (normalized === 'STANDALONE') {
      return StationStructureType.STANDALONE;
    }

    throw new BadRequestException(
      'Station structure type must be STANDALONE, SHARED_TANK, or DISPENSER',
    );
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

    const structureType = this.mapStructureType(input.structureType);
    const requestedOpeningBalance = this.normalizeOpeningBalance(
      input.openingBalance,
    );
    const requestedCurrentCounter = this.normalizeCurrentCounter(
      input.currentCounter,
    );
    const requestedCapacity = this.normalizeCapacity(input.capacity);
    const parentStationId = this.normalizeOptionalText(input.parentStationId);

    if (
      structureType !== StationStructureType.DISPENSER &&
      parentStationId
    ) {
      throw new BadRequestException(
        'Only DISPENSER stations can have a parent station',
      );
    }

    if (
      structureType === StationStructureType.DISPENSER &&
      !parentStationId
    ) {
      throw new BadRequestException(
        'Parent shared tank is required for a DISPENSER station',
      );
    }

    if (
      structureType === StationStructureType.DISPENSER &&
      requestedOpeningBalance !== 0
    ) {
      throw new BadRequestException(
        'DISPENSER stations do not own stock and cannot have an opening balance',
      );
    }

    if (
      structureType === StationStructureType.DISPENSER &&
      requestedCapacity !== null &&
      requestedCapacity !== 0
    ) {
      throw new BadRequestException(
        'DISPENSER stations do not own stock capacity',
      );
    }

    if (
      structureType === StationStructureType.SHARED_TANK &&
      requestedCurrentCounter !== 0
    ) {
      throw new BadRequestException(
        'SHARED_TANK stations do not have a direct station counter',
      );
    }

    if (parentStationId) {
      const parentStation = await db.station.findFirst({
        where: {
          id: parentStationId,
          companyId: input.companyId,
          deletedAt: null,
        },
        select: {
          id: true,
          stationId: true,
          structureType: true,
          projectId: true,
        },
      });

      if (!parentStation) {
        throw new BadRequestException(
          'Parent shared tank was not found in this company',
        );
      }

      if (parentStation.structureType !== StationStructureType.SHARED_TANK) {
        throw new BadRequestException(
          'DISPENSER parent station must be a SHARED_TANK',
        );
      }

      if ((parentStation.projectId || null) !== (input.projectId || null)) {
        throw new BadRequestException(
          'DISPENSER and parent SHARED_TANK must belong to the same project',
        );
      }
    }

    const openingBalance =
      structureType === StationStructureType.DISPENSER
        ? 0
        : requestedOpeningBalance;
    const currentCounter =
      structureType === StationStructureType.SHARED_TANK
        ? 0
        : requestedCurrentCounter;
    const capacity =
      structureType === StationStructureType.DISPENSER
        ? null
        : requestedCapacity;

    const createdStation = await db.station.create({
      data: {
        companyId: input.companyId,
        stationId,
        name: this.normalizeOptionalText(input.name),
        type: this.normalizeOptionalText(input.type),
        structureType,
        parentStationId,
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
        parentStation: true,
        dispensers: {
          where: {
            deletedAt: null,
          },
          orderBy: {
            stationId: 'asc',
          },
        },
      },
    });

    if (structureType !== StationStructureType.DISPENSER) {
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
    }

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
