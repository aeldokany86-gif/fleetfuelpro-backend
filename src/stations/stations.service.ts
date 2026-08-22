import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { StationCreationDomainService } from './station-creation-domain.service';

@Injectable()
export class StationsService {
  constructor(
    private prisma: PrismaService,
    private readonly stationCreationDomainService: StationCreationDomainService,
  ) {}

  private normalizeStationId(stationId: string) {
    return this.stationCreationDomainService.normalizeStationId(stationId);
  }

  private mapStationStatus(status?: string) {
    return this.stationCreationDomainService.mapStationStatus(status);
  }

  private parseOptionalDate(value?: string, fallback = new Date()) {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Invalid date');
    }
    return date;
  }


  private normalizeRoleName(roleName: string) {
    return String(roleName || '')
      .trim()
      .toUpperCase()
      .replace(/[\s_-]+/g, '');
  }

  private isAdminRole(roleName: string) {
    const normalized = this.normalizeRoleName(roleName);
    return (
      normalized === 'ADMIN' ||
      normalized === 'PLATFORMADMIN' ||
      normalized === 'PLATFORMUSER'
    );
  }

  private isOfficerRole(roleName: string) {
    return this.normalizeRoleName(roleName) === 'OFFICER';
  }

  private isManagerRole(roleName: string) {
    return this.normalizeRoleName(roleName) === 'MANAGER';
  }

  private async getRequester(requestedByUserId: string, companyId: string) {
    const requester = await this.prisma.user.findFirst({
      where: {
        id: requestedByUserId,
        companyId,
        deletedAt: null,
        isActive: true,
      },
      include: {
        role: true,
      },
    });

    if (!requester) {
      throw new BadRequestException('Requester user is invalid or inactive');
    }

    return requester;
  }

  private async ensureStationActionDirectPermission(
    station: any,
    userId: string | undefined,
    actionType: 'ZERO_BALANCE' | 'INVENTORY_ADJUSTMENT' | 'COUNTER_RESET',
  ) {
    if (!userId) {
      throw new BadRequestException('Actor user is required');
    }

    const actor = await this.getRequester(userId, station.companyId);
    const roleName = actor.role?.name || '';

    if (actionType === 'INVENTORY_ADJUSTMENT') {
      if (!this.isAdminRole(roleName)) {
        throw new BadRequestException(
          'Inventory adjustment requires Admin approval',
        );
      }
      return actor;
    }

    if (this.isAdminRole(roleName)) {
      return actor;
    }

    if (!this.isManagerRole(roleName)) {
      throw new BadRequestException(
        'Only the assigned Project Manager or Admin can execute this station action directly',
      );
    }

    const projectManagerId =
      station.project?.projectManagerId ||
      (station.projectId
        ? (
            await this.prisma.project.findFirst({
              where: {
                id: station.projectId,
                companyId: station.companyId,
                deletedAt: null,
                isActive: true,
              },
              select: {
                projectManagerId: true,
              },
            })
          )?.projectManagerId
        : null);

    if (!projectManagerId || projectManagerId !== userId) {
      throw new BadRequestException(
        'Only the assigned Project Manager can execute this station action directly',
      );
    }

    return actor;
  }

  private buildUniqueApprovers(
    approvers: Array<{
      approverUserId: string;
      projectId: string;
      approvalStage: string;
    }>,
  ) {
    return approvers.filter(
      (item, index, list) =>
        list.findIndex(
          (candidate) => candidate.approverUserId === item.approverUserId,
        ) === index,
    );
  }

  private async ensureCompany(companyId: string) {
    const company = await this.prisma.company.findFirst({
      where: {
        id: companyId,
        deletedAt: null,
        isActive: true,
      },
    });

    if (!company) {
      throw new BadRequestException('Company not found or inactive');
    }

    return company;
  }

  private async ensureProject(projectId: string | null | undefined, companyId: string) {
    if (!projectId) return null;

    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        companyId,
        deletedAt: null,
        isActive: true,
      },
    });

    if (!project) {
      throw new BadRequestException('Project is invalid or inactive');
    }

    return project;
  }

  async findAll(
    companyId?: string,
    projectId?: string,
    includeDeleted = false,
  ) {
    return this.prisma.station.findMany({
      where: {
        ...(includeDeleted ? {} : { deletedAt: null }),
        ...(companyId ? { companyId } : {}),
        ...(projectId ? { projectId } : {}),
      },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            code: true,
            country: true,
            currency: true,
          },
        },
        project: {
          select: {
            id: true,
            code: true,
            name: true,
            projectManagerId: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOne(id: string) {
    const station = await this.prisma.station.findFirst({
      where: {
        id,
        deletedAt: null,
      },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            code: true,
            country: true,
            currency: true,
          },
        },
        project: {
          select: {
            id: true,
            code: true,
            name: true,
            projectManagerId: true,
          },
        },
        counterResetHistory: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        stockMovements: {
          orderBy: {
            movementAt: 'desc',
          },
          take: 50,
        },
        assignmentHistory: {
          include: {
            fromProject: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
            toProject: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
            assignedBy: {
              select: {
                id: true,
                fullName: true,
                email: true,
              },
            },
          },
          orderBy: {
            assignedAt: 'desc',
          },
        },
      },
    });

    if (!station) {
      throw new NotFoundException('Station not found');
    }

    return station;
  }

  async create(body: {
    companyId: string;
    stationId: string;
    name?: string;
    type?: string;
    capacity?: number;
    openingBalance?: number;
    currentCounter?: number;
    projectId?: string;
    status?: string;
    createdById?: string;
  }) {
    await this.ensureCompany(body.companyId);

    if (!body.createdById) {
      throw new BadRequestException('Creator user is required');
    }

    const creator = await this.prisma.user.findFirst({
      where: {
        id: body.createdById,
        companyId: body.companyId,
        deletedAt: null,
        isActive: true,
      },
      include: {
        role: true,
      },
    });

    if (!creator) {
      throw new BadRequestException('Creator user is invalid or inactive');
    }

    if (!this.isAdminRole(creator.role?.name || '')) {
      throw new BadRequestException('Only Admin can create stations');
    }

    const stationId = this.normalizeStationId(body.stationId);
    if (!stationId) {
      throw new BadRequestException('Station ID is required');
    }

    if (body.projectId) {
      await this.ensureProject(body.projectId, body.companyId);
    }

    const duplicate = await this.prisma.station.findFirst({
      where: {
        companyId: body.companyId,
        stationId,
      },
    });

    if (duplicate) {
      if (duplicate.deletedAt) {
        throw new BadRequestException(
          'This Station ID was previously used and cannot be reused',
        );
      }

      throw new BadRequestException(
        'Station ID already exists in this company',
      );
    }

    const openingBalance =
      this.stationCreationDomainService.normalizeOpeningBalance(
        body.openingBalance,
      );

    const currentCounter =
      this.stationCreationDomainService.normalizeCurrentCounter(
        body.currentCounter,
      );

    const capacity =
      this.stationCreationDomainService.normalizeCapacity(
        body.capacity,
      );

    return this.prisma.$transaction(
      (tx) =>
        this.stationCreationDomainService.createStation(tx, {
          companyId: body.companyId,
          stationId,
          name: body.name,
          type: body.type,
          capacity,
          openingBalance,
          currentCounter,
          projectId: body.projectId || null,
          status: body.status,
          createdById: body.createdById,
        }),
      { maxWait: 5000, timeout: 15000 },
    );
  }

  async update(
    id: string,
    body: {
      stationId?: string;
      name?: string | null;
      type?: string | null;
      capacity?: number | null;
      status?: string;
      projectId?: never;
      currentStock?: never;
      openingBalance?: never;
      currentCounter?: never;
    },
  ) {
    const existingStation = await this.prisma.station.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!existingStation) {
      throw new NotFoundException('Station not found');
    }

    const nextStationId =
      body.stationId !== undefined
        ? this.normalizeStationId(body.stationId)
        : existingStation.stationId;

    if (!nextStationId) {
      throw new BadRequestException('Station ID is required');
    }

    if (nextStationId !== existingStation.stationId) {
      const duplicate = await this.prisma.station.findFirst({
        where: {
          companyId: existingStation.companyId,
          stationId: nextStationId,
          NOT: {
            id,
          },
        },
      });

      if (duplicate) {
        if (duplicate.deletedAt) {
          throw new BadRequestException(
            'This Station ID was previously used and cannot be reused',
          );
        }

        throw new BadRequestException(
          'Station ID already exists in this company',
        );
      }
    }

    if (Object.prototype.hasOwnProperty.call(body as any, 'projectId')) {
      throw new BadRequestException(
        'Station project cannot be changed from edit. Use station transfer workflow.',
      );
    }

    if (Object.prototype.hasOwnProperty.call(body as any, 'currentStock')) {
      throw new BadRequestException(
        'Station current stock cannot be changed from edit. Use inventory adjustment workflow.',
      );
    }

    if (Object.prototype.hasOwnProperty.call(body as any, 'openingBalance')) {
      throw new BadRequestException(
        'Station opening balance cannot be changed from edit. Use inventory adjustment workflow.',
      );
    }

    if (Object.prototype.hasOwnProperty.call(body as any, 'currentCounter')) {
      throw new BadRequestException(
        'Station counter cannot be changed from edit. Use counter reset workflow.',
      );
    }

    return this.prisma.station.update({
      where: {
        id,
      },
      data: {
        ...(body.stationId !== undefined ? { stationId: nextStationId } : {}),
        ...(body.name !== undefined ? { name: body.name?.trim() || null } : {}),
        ...(body.type !== undefined ? { type: body.type?.trim() || null } : {}),
        ...(body.capacity !== undefined
          ? {
              capacity:
                body.capacity === null
                  ? null
                  : Number(body.capacity),
            }
          : {}),
        ...(body.status !== undefined
          ? { status: this.mapStationStatus(body.status) as any }
          : {}),
      },
      include: {
        company: true,
        project: true,
      },
    });
  }

  async resetCounter(
    id: string,
    body: {
      newCounter: number;
      reason: string;
      effectiveAt?: string;
      createdByUserId?: string;
    },
  ) {
    const station = await this.prisma.station.findFirst({
      where: {
        id,
        deletedAt: null,
      },
      include: {
        project: true,
      },
    });

    if (!station) {
      throw new NotFoundException('Station not found');
    }

    await this.ensureStationActionDirectPermission(
      station,
      body.createdByUserId,
      'COUNTER_RESET',
    );

    const newCounter = Number(body.newCounter);
    if (!Number.isFinite(newCounter) || newCounter < 0) {
      throw new BadRequestException(
        'New counter must be a valid zero or positive number',
      );
    }

    if (!body.reason?.trim()) {
      throw new BadRequestException('Reset reason is required');
    }

    const effectiveAt = this.parseOptionalDate(body.effectiveAt);

    if (effectiveAt.getTime() < station.createdAt.getTime()) {
      throw new BadRequestException(
        'Reset effective date cannot be before the station creation date',
      );
    }

    if (effectiveAt.getTime() > Date.now()) {
      throw new BadRequestException(
        'Reset effective date cannot be in the future',
      );
    }

    return this.prisma.$transaction(
      async (tx) => {
        const resetRecord = await tx.stationCounterReset.create({
          data: {
            stationId: station.id,
            companyId: station.companyId,
            // These values are recalculated from the complete chronological
            // history immediately after creating the reset record.
            oldCounter: Number(station.currentCounter || 0),
            newCounter,
            lifetimeAtReset: this.getEffectiveStationLifetime(station),
            oldCounterCycle: Number(station.currentCounterCycle || 1),
            newCounterCycle: Number(station.currentCounterCycle || 1) + 1,
            reason: body.reason.trim(),
            effectiveAt,
            createdByUserId: body.createdByUserId || null,
          },
        });

        await this.rebuildStationLifetimeHistory(tx, station.id);

        const [updatedStation, rebuiltResetRecord] = await Promise.all([
          tx.station.findUnique({
            where: { id: station.id },
            include: {
              company: true,
              project: true,
            },
          }),
          tx.stationCounterReset.findUnique({
            where: { id: resetRecord.id },
          }),
        ]);

        return {
          station: updatedStation,
          resetRecord: rebuiltResetRecord,
        };
      },
      { maxWait: 5000, timeout: 15000 },
    );
  }

  private getEffectiveStationLifetime(station: any) {
    const storedLifetime = Number(station?.currentLifetimeCounter || 0);
    const currentReading = Number(station?.currentCounter || 0);
    const currentCycle = Number(station?.currentCounterCycle || 1);

    if (currentCycle === 1 && storedLifetime === 0 && currentReading > 0) {
      return currentReading;
    }

    return storedLifetime;
  }

  private operationUsesStationCounter(operation: any, stationId: string) {
    if (
      ['INTERNAL_TRANSFER', 'EXTERNAL_SUPPLY', 'EXTERNAL_TRANSFER'].includes(
        operation.type,
      )
    ) {
      return operation.destinationStationId === stationId;
    }

    return false;
  }

  private getOperationCounterDate(operation: any) {
    return operation.occurredAt || operation.createdAt;
  }

  private async rebuildStationLifetimeHistory(tx: any, stationId: string) {
    const station = await tx.station.findUnique({
      where: { id: stationId },
      select: {
        id: true,
        currentCounter: true,
        currentLifetimeCounter: true,
        currentCounterCycle: true,
      },
    });

    if (!station) {
      throw new NotFoundException('Station not found');
    }

    const [candidateOperations, resets] = await Promise.all([
      tx.operation.findMany({
        where: {
          status: 'COMPLETED',
          stationCounter: { not: null },
          OR: [
            { sourceStationId: stationId },
            { destinationStationId: stationId },
          ],
        },
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          type: true,
          sourceStationId: true,
          destinationStationId: true,
          stationCounter: true,
          occurredAt: true,
          completedAt: true,
          createdAt: true,
        },
      }),
      tx.stationCounterReset.findMany({
        where: { stationId },
        orderBy: [{ effectiveAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          oldCounter: true,
          newCounter: true,
          lifetimeAtReset: true,
          oldCounterCycle: true,
          newCounterCycle: true,
          effectiveAt: true,
          createdAt: true,
        },
      }),
    ]);

    const operations = candidateOperations.filter((operation: any) =>
      this.operationUsesStationCounter(operation, stationId),
    );

    const events = [
      ...operations.map((operation: any) => ({
        kind: 'OPERATION' as const,
        at: this.getOperationCounterDate(operation),
        createdAt: operation.createdAt,
        id: operation.id,
        item: operation,
      })),
      ...resets.map((reset: any) => ({
        kind: 'RESET' as const,
        at: reset.effectiveAt,
        createdAt: reset.createdAt,
        id: reset.id,
        item: reset,
      })),
    ].sort((a, b) => {
      const effectiveTimeDiff =
        new Date(a.at).getTime() - new Date(b.at).getTime();
      if (effectiveTimeDiff !== 0) return effectiveTimeDiff;

      // A meter replacement effective at the exact operation time starts the
      // new counter cycle before that operation reading is evaluated.
      if (a.kind !== b.kind) return a.kind === 'RESET' ? -1 : 1;

      const createdTimeDiff =
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (createdTimeDiff !== 0) return createdTimeDiff;

      return String(a.id).localeCompare(String(b.id));
    });

    // A station with no counter history keeps its current creation values.
    // This also protects a newly-created station before its first operation.
    if (events.length === 0) {
      return;
    }

    let cycleNumber = 1;
    let cycleStartReading: number | null = null;
    let lifetimeAtCycleStart = 0;
    let latestReading: number | null = null;
    let latestLifetime = 0;

    for (const event of events) {
      if (event.kind === 'RESET') {
        const reset = event.item;

        // When the first historical event is a meter replacement, the reset's
        // stored old reading is the only recoverable reading of the removed
        // meter. It becomes the station lifetime baseline.
        if (latestReading === null) {
          const historicalOldCounter = Number(reset.oldCounter || 0);
          const historicalLifetime = Number(reset.lifetimeAtReset || 0);

          if (!Number.isFinite(historicalOldCounter) || historicalOldCounter < 0) {
            throw new BadRequestException(
              'Reset old counter must be a valid zero or positive number',
            );
          }

          latestReading = historicalOldCounter;
          latestLifetime =
            Number.isFinite(historicalLifetime) && historicalLifetime > 0
              ? historicalLifetime
              : historicalOldCounter;
          cycleNumber = Math.max(Number(reset.oldCounterCycle || 1), 1);
        }

        const oldCycle = cycleNumber;
        const newCycle = oldCycle + 1;
        const newCounter = Number(reset.newCounter || 0);

        if (!Number.isFinite(newCounter) || newCounter < 0) {
          throw new BadRequestException(
            'Reset new counter must be a valid zero or positive number',
          );
        }

        await tx.stationCounterReset.update({
          where: { id: reset.id },
          data: {
            oldCounter: latestReading,
            lifetimeAtReset: latestLifetime,
            oldCounterCycle: oldCycle,
            newCounterCycle: newCycle,
          },
        });

        cycleNumber = newCycle;
        cycleStartReading = newCounter;
        lifetimeAtCycleStart = latestLifetime;
        latestReading = newCounter;
        continue;
      }

      const reading = Number(event.item.stationCounter);
      if (!Number.isFinite(reading) || reading < 0) {
        throw new BadRequestException(
          'Station counter must be a valid zero or positive number',
        );
      }

      // The first recorded operation is the historical baseline. Under the
      // agreed Option A, its reading is also the first lifetime reading.
      if (latestReading === null || cycleStartReading === null) {
        cycleNumber = 1;
        cycleStartReading = reading;
        lifetimeAtCycleStart = reading;
        latestReading = reading;
        latestLifetime = reading;
      } else {
        if (reading < cycleStartReading) {
          throw new BadRequestException(
            `Station counter cannot be lower than cycle start reading (${cycleStartReading}).`,
          );
        }

        if (reading < latestReading) {
          throw new BadRequestException(
            `Station counter cannot decrease inside counter cycle ${cycleNumber}. Previous reading is ${latestReading}.`,
          );
        }

        latestReading = reading;
        latestLifetime = lifetimeAtCycleStart + (reading - cycleStartReading);
      }

      await tx.operation.update({
        where: { id: event.item.id },
        data: {
          lifetimeCounter: latestLifetime,
          stationCounterCycleNumber: cycleNumber,
        },
      });
    }

    if (latestReading === null) {
      return;
    }

    await tx.station.update({
      where: { id: stationId },
      data: {
        currentCounter: latestReading,
        currentLifetimeCounter: latestLifetime,
        currentCounterCycle: cycleNumber,
      },
    });
  }

  async getCounterMeterHistory(filters: {
    companyId?: string;
    projectId?: string;
    stationId?: string;
    dateFrom?: string;
    dateTo?: string;
    eventType?: string;
  }) {
    const dateFrom = filters.dateFrom
      ? this.parseOptionalDate(filters.dateFrom)
      : undefined;
    const dateTo = filters.dateTo
      ? this.parseOptionalDate(filters.dateTo)
      : undefined;

    if (dateTo) {
      dateTo.setHours(23, 59, 59, 999);
    }

    const eventType = String(filters.eventType || 'ALL')
      .trim()
      .toUpperCase();

    if (!['ALL', 'OPERATION', 'RESET', 'CORRECTION'].includes(eventType)) {
      throw new BadRequestException(
        'Event type must be ALL, OPERATION, RESET, or CORRECTION',
      );
    }

    const stations = await this.prisma.station.findMany({
      where: {
        deletedAt: null,
        ...(filters.companyId ? { companyId: filters.companyId } : {}),
        ...(filters.stationId ? { id: filters.stationId } : {}),
      },
      select: {
        id: true,
        stationId: true,
        name: true,
        companyId: true,
        currentCounter: true,
        currentLifetimeCounter: true,
        currentCounterCycle: true,
        project: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        assignmentHistory: {
          orderBy: {
            assignedAt: 'asc',
          },
          select: {
            assignedAt: true,
            fromProject: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
            toProject: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: [{ stationId: 'asc' }, { id: 'asc' }],
    });

    if (filters.stationId && stations.length === 0) {
      throw new NotFoundException('Station not found');
    }

    if (stations.length === 0) {
      return [];
    }

    const stationIds = stations.map((station) => station.id);

    const [candidateOperations, resets, corrections] = await Promise.all([
      eventType === 'RESET' || eventType === 'CORRECTION'
        ? Promise.resolve([])
        : this.prisma.operation.findMany({
            where: {
              status: 'COMPLETED',
              stationCounter: { not: null },
              OR: [
                { sourceStationId: { in: stationIds } },
                { destinationStationId: { in: stationIds } },
              ],
            },
            select: {
              id: true,
              companyId: true,
              operationNo: true,
              type: true,
              status: true,
              sourceStationId: true,
              destinationStationId: true,
              stationCounter: true,
              lifetimeCounter: true,
              stationCounterCycleNumber: true,
              notes: true,
              projectIdAtOperation: true,
              projectNameAtOperation: true,
              sourceProjectIdAtOperation: true,
              sourceProjectNameAtOperation: true,
              destinationProjectIdAtOperation: true,
              destinationProjectNameAtOperation: true,
              occurredAt: true,
              completedAt: true,
              createdAt: true,
              requestedBy: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                },
              },
            },
          }),
      eventType === 'OPERATION' || eventType === 'CORRECTION'
        ? Promise.resolve([])
        : this.prisma.stationCounterReset.findMany({
            where: {
              stationId: { in: stationIds },
            },
            select: {
              id: true,
              stationId: true,
              companyId: true,
              oldCounter: true,
              newCounter: true,
              lifetimeAtReset: true,
              oldCounterCycle: true,
              newCounterCycle: true,
              reason: true,
              effectiveAt: true,
              createdAt: true,
              createdBy: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                },
              },
            },
          }),
      eventType === 'OPERATION' || eventType === 'RESET'
        ? Promise.resolve([])
        : this.prisma.operationCorrection.findMany({
            where: {
              fieldName: 'STATION_COUNTER',
              status: 'APPLIED',
              operation: {
                status: 'COMPLETED',
                OR: [
                  { sourceStationId: { in: stationIds } },
                  { destinationStationId: { in: stationIds } },
                ],
              },
            },
            select: {
              id: true,
              oldValue: true,
              newValue: true,
              reason: true,
              appliedAt: true,
              createdAt: true,
              operation: {
                select: {
                  id: true,
                  companyId: true,
                  operationNo: true,
                  type: true,
                  status: true,
                  sourceStationId: true,
                  destinationStationId: true,
                  stationCounter: true,
                  lifetimeCounter: true,
                  stationCounterCycleNumber: true,
                  projectIdAtOperation: true,
                  projectNameAtOperation: true,
                  sourceProjectIdAtOperation: true,
                  sourceProjectNameAtOperation: true,
                  destinationProjectIdAtOperation: true,
                  destinationProjectNameAtOperation: true,
                  occurredAt: true,
                  completedAt: true,
                  createdAt: true,
                },
              },
              reviewedBy: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                },
              },
              requestedBy: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                },
              },
            },
          }),
    ]);

    const stationMap = new Map(
      stations.map((station) => [station.id, station]),
    );

    const getStationProjectAt = (station: any, eventAt: Date | string) => {
      const eventTime = new Date(eventAt).getTime();
      const assignments = station?.assignmentHistory || [];

      let historicalProject =
        assignments.length > 0
          ? assignments[0]?.fromProject || station?.project || null
          : station?.project || null;

      for (const assignment of assignments) {
        if (new Date(assignment.assignedAt).getTime() > eventTime) break;
        historicalProject = assignment.toProject || historicalProject;
      }

      return historicalProject;
    };

    const getOperationStationProject = (
      operation: any,
      station: any,
      eventAt: Date | string,
    ) => {
      const historicalFallback = getStationProjectAt(station, eventAt);

      const projectId =
        operation?.destinationProjectIdAtOperation ||
        operation?.projectIdAtOperation ||
        historicalFallback?.id ||
        null;

      const projectName =
        operation?.destinationProjectNameAtOperation ||
        operation?.projectNameAtOperation ||
        historicalFallback?.name ||
        null;

      const projectCode =
        historicalFallback?.id === projectId
          ? historicalFallback?.code || null
          : null;

      return projectId || projectName
        ? { id: projectId, name: projectName, code: projectCode }
        : historicalFallback;
    };

    const eventsByStation = new Map<string, any[]>();
    for (const station of stations) {
      eventsByStation.set(station.id, []);
    }

    for (const operation of candidateOperations as any[]) {
      for (const stationId of stationIds) {
        if (!this.operationUsesStationCounter(operation, stationId)) continue;

        eventsByStation.get(stationId)?.push({
          kind: 'OPERATION' as const,
          at: this.getOperationCounterDate(operation),
          createdAt: operation.createdAt,
          id: operation.id,
          item: operation,
        });
      }
    }

    for (const reset of resets as any[]) {
      eventsByStation.get(reset.stationId)?.push({
        kind: 'RESET' as const,
        at: reset.effectiveAt,
        createdAt: reset.createdAt,
        id: reset.id,
        item: reset,
      });
    }

    for (const correction of corrections as any[]) {
      const operation = correction.operation;
      if (!operation) continue;

      for (const stationId of stationIds) {
        if (!this.operationUsesStationCounter(operation, stationId)) continue;

        eventsByStation.get(stationId)?.push({
          kind: 'CORRECTION' as const,
          at: correction.appliedAt || correction.createdAt,
          createdAt: correction.createdAt,
          id: correction.id,
          item: correction,
        });
      }
    }

    const rows: any[] = [];

    for (const [stationId, stationEvents] of eventsByStation.entries()) {
      const station = stationMap.get(stationId);
      if (!station) continue;

      stationEvents.sort((a, b) => {
        const effectiveTimeDiff =
          new Date(a.at).getTime() - new Date(b.at).getTime();
        if (effectiveTimeDiff !== 0) return effectiveTimeDiff;

        if (a.kind !== b.kind) {
          const priority = { RESET: 1, OPERATION: 2, CORRECTION: 3 };
          return (priority[a.kind] || 9) - (priority[b.kind] || 9);
        }

        const createdTimeDiff =
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (createdTimeDiff !== 0) return createdTimeDiff;

        return String(a.id).localeCompare(String(b.id));
      });

      let previousCounter: number | null = null;
      let previousLifetime = 0;
      let currentCycle = 1;
      let cycleStartCounter: number | null = null;
      let lifetimeAtCycleStart = 0;

      for (const event of stationEvents) {
        const eventDate = new Date(event.at);
        const diagnostics: string[] = [];

        if (event.kind === 'RESET') {
          const reset = event.item;
          const storedOldCounter = Number(reset.oldCounter || 0);
          const newCounter = Number(reset.newCounter || 0);
          const storedLifetime = Number(reset.lifetimeAtReset || 0);
          const storedOldCycle = Number(reset.oldCounterCycle || 1);
          const storedNewCycle = Number(reset.newCounterCycle || 1);

          if (previousCounter === null) {
            previousCounter = storedOldCounter;
            previousLifetime = storedLifetime || storedOldCounter;
            currentCycle = Math.max(storedOldCycle, 1);
          }

          if (storedOldCounter !== previousCounter) {
            diagnostics.push(
              `Stored old counter (${storedOldCounter}) does not match previous timeline reading (${previousCounter})`,
            );
          }

          if (storedLifetime !== previousLifetime) {
            diagnostics.push(
              `Stored lifetime at reset (${storedLifetime}) does not match previous timeline lifetime (${previousLifetime})`,
            );
          }

          if (storedOldCycle !== currentCycle) {
            diagnostics.push(
              `Stored old cycle (${storedOldCycle}) does not match timeline cycle (${currentCycle})`,
            );
          }

          const expectedNewCycle = currentCycle + 1;
          if (storedNewCycle !== expectedNewCycle) {
            diagnostics.push(
              `Stored new cycle (${storedNewCycle}) should be ${expectedNewCycle}`,
            );
          }

          currentCycle = expectedNewCycle;
          cycleStartCounter = newCounter;
          lifetimeAtCycleStart = previousLifetime;
          previousCounter = newCounter;

          if (
            (!dateFrom || eventDate >= dateFrom) &&
            (!dateTo || eventDate <= dateTo)
          ) {
            rows.push({
              eventId: reset.id,
              eventDate,
              eventType: 'RESET',
              referenceNo: reset.id,
              operationType: null,
              operationStatus: null,
              station: {
                id: station.id,
                stationId: station.stationId,
                name: station.name,
                companyId: station.companyId,
                project: getStationProjectAt(station, event.at),
              },
              counterBefore: storedOldCounter,
              counterAfter: newCounter,
              deltaCounter: 0,
              lifetimeBefore: storedLifetime,
              lifetimeAfter: storedLifetime,
              counterCycleBefore: storedOldCycle,
              counterCycleAfter: storedNewCycle,
              performedBy: reset.createdBy,
              notes: reset.reason,
              diagnostics,
              hasIssue: diagnostics.length > 0,
            });
          }

          continue;
        }

        if (event.kind === 'CORRECTION') {
          const correction = event.item;
          const operation = correction.operation;
          const counterBefore = Number(correction.oldValue);
          const counterAfter = Number(correction.newValue);

          if (
            (!dateFrom || eventDate >= dateFrom) &&
            (!dateTo || eventDate <= dateTo)
          ) {
            rows.push({
              eventId: correction.id,
              eventDate,
              eventType: 'CORRECTION',
              referenceNo: operation?.operationNo || correction.id,
              operationType: operation?.type || null,
              operationStatus: operation?.status || null,
              station: {
                id: station.id,
                stationId: station.stationId,
                name: station.name,
                companyId: station.companyId,
                project: getOperationStationProject(
                  operation,
                  station,
                  operation?.occurredAt || operation?.createdAt,
                ),
              },
              counterBefore: Number.isFinite(counterBefore) ? counterBefore : null,
              counterAfter: Number.isFinite(counterAfter) ? counterAfter : null,
              lifetimeAfter:
                operation?.lifetimeCounter === null ||
                operation?.lifetimeCounter === undefined
                  ? null
                  : Number(operation.lifetimeCounter),
              counterCycleBefore: operation?.stationCounterCycleNumber || currentCycle,
              counterCycleAfter: operation?.stationCounterCycleNumber || currentCycle,
              performedBy: correction.reviewedBy || correction.requestedBy,
              notes: correction.reason,
              diagnostics: [],
              hasIssue: false,
            });
          }

          // The correction is an audit event only. The corrected value is already
          // stored on the operation and must not advance the operational chain twice.
          continue;
        }

        const operation = event.item;
        const reading = Number(operation.stationCounter);
        const storedLifetime =
          operation.lifetimeCounter === null
            ? null
            : Number(operation.lifetimeCounter);
        const storedCycle =
          operation.stationCounterCycleNumber === null
            ? null
            : Number(operation.stationCounterCycleNumber);

        let expectedLifetime: number;
        let deltaCounter: number;

        if (previousCounter === null || cycleStartCounter === null) {
          currentCycle = 1;
          cycleStartCounter = reading;
          lifetimeAtCycleStart = reading;
          deltaCounter = reading;
          expectedLifetime = reading;
        } else {
          deltaCounter = reading - previousCounter;
          expectedLifetime =
            lifetimeAtCycleStart + (reading - cycleStartCounter);

          if (reading < cycleStartCounter) {
            diagnostics.push(
              `Counter reading (${reading}) is lower than cycle start (${cycleStartCounter})`,
            );
          }

          if (reading < previousCounter) {
            diagnostics.push(
              `Counter decreased inside cycle ${currentCycle}: ${previousCounter} -> ${reading}`,
            );
          }
        }

        if (storedLifetime === null) {
          diagnostics.push('Stored lifetime counter is missing');
        } else if (storedLifetime !== expectedLifetime) {
          diagnostics.push(
            `Stored lifetime (${storedLifetime}) does not match expected lifetime (${expectedLifetime})`,
          );
        }

        if (storedCycle === null) {
          diagnostics.push('Stored counter cycle number is missing');
        } else if (storedCycle !== currentCycle) {
          diagnostics.push(
            `Stored cycle (${storedCycle}) does not match expected cycle (${currentCycle})`,
          );
        }

        const lifetimeBefore = previousLifetime;
        previousCounter = reading;
        previousLifetime = expectedLifetime;

        if (
          (!dateFrom || eventDate >= dateFrom) &&
          (!dateTo || eventDate <= dateTo)
        ) {
          rows.push({
            eventId: operation.id,
            eventDate,
            eventType: 'OPERATION',
            referenceNo: operation.operationNo,
            operationType: operation.type,
            operationStatus: operation.status,
            station: {
              id: station.id,
              stationId: station.stationId,
              name: station.name,
              companyId: station.companyId,
              project: getOperationStationProject(
                operation,
                station,
                operation?.occurredAt || operation?.createdAt,
              ),
            },
            counterBefore:
              previousCounter === reading ? reading - deltaCounter : null,
            counterAfter: reading,
            deltaCounter,
            lifetimeBefore,
            lifetimeAfter: storedLifetime,
            expectedLifetimeAfter: expectedLifetime,
            counterCycleBefore: currentCycle,
            counterCycleAfter: storedCycle,
            performedBy: operation.requestedBy,
            notes: operation.notes,
            diagnostics,
            hasIssue: diagnostics.length > 0,
          });
        }
      }
    }

    const projectScopedRows = filters.projectId
      ? rows.filter((row) => row?.station?.project?.id === filters.projectId)
      : rows;

    return projectScopedRows.sort((a, b) => {
      const dateDiff =
        new Date(a.eventDate).getTime() - new Date(b.eventDate).getTime();
      if (dateDiff !== 0) return dateDiff;

      if (a.eventType !== b.eventType) {
        const priority = { RESET: 1, OPERATION: 2, CORRECTION: 3 };
        return (priority[a.eventType] || 9) - (priority[b.eventType] || 9);
      }

      return String(a.eventId).localeCompare(String(b.eventId));
    });
  }

  async getCounterResetHistory(stationId: string) {
    const station = await this.prisma.station.findFirst({
      where: {
        id: stationId,
        deletedAt: null,
      },
    });

    if (!station) {
      throw new NotFoundException('Station not found');
    }

    return this.prisma.stationCounterReset.findMany({
      where: {
        stationId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        createdBy: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
      },
    });
  }

  async getAssignmentHistory(stationId: string) {
    const station = await this.prisma.station.findFirst({
      where: {
        id: stationId,
        deletedAt: null,
      },
      select: {
        id: true,
      },
    });

    if (!station) {
      throw new NotFoundException('Station not found');
    }

    return this.prisma.stationAssignmentHistory.findMany({
      where: {
        stationId,
      },
      orderBy: {
        assignedAt: 'desc',
      },
      include: {
        fromProject: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        toProject: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        assignedBy: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
        transferRequest: true,
      },
    });
  }

  async getAllStockMovements(filters: {
    companyId?: string;
    projectId?: string;
    stationId?: string;
    dateFrom?: string;
    dateTo?: string;
    movementType?: string;
    direction?: string;
  }) {
    const dateFrom = filters.dateFrom
      ? this.parseOptionalDate(filters.dateFrom)
      : undefined;
    const dateTo = filters.dateTo
      ? this.parseOptionalDate(filters.dateTo)
      : undefined;

    if (dateTo) {
      dateTo.setHours(23, 59, 59, 999);
    }

    const direction = String(filters.direction || 'all').trim().toLowerCase();
    const movementType = String(filters.movementType || '').trim().toUpperCase();

    const movements = await this.prisma.stationStockMovement.findMany({
      where: {
        ...(filters.companyId ? { companyId: filters.companyId } : {}),
        ...(filters.stationId ? { stationId: filters.stationId } : {}),
        ...(movementType && movementType !== 'ALL'
          ? { movementType: movementType as any }
          : {}),
        ...(direction === 'inbound' ? { quantity: { gt: 0 } } : {}),
        ...(direction === 'outbound' ? { quantity: { lt: 0 } } : {}),
        ...(dateFrom || dateTo
          ? {
              movementAt: {
                ...(dateFrom ? { gte: dateFrom } : {}),
                ...(dateTo ? { lte: dateTo } : {}),
              },
            }
          : {}),
        station: {
          is: {
            deletedAt: null,
            ...(filters.projectId ? { projectId: filters.projectId } : {}),
          },
        },
      },
      include: {
        station: {
          include: {
            project: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        },
        createdBy: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
      },
      orderBy: [{ movementAt: 'asc' }, { createdAt: 'asc' }],
    });

    const operationIds = Array.from(
      new Set(
        movements
          .filter(
            (movement) =>
              String(movement.referenceType || '').toLowerCase() === 'operation' &&
              movement.referenceId,
          )
          .map((movement) => movement.referenceId as string),
      ),
    );

    const operations = operationIds.length
      ? await this.prisma.operation.findMany({
          where: { id: { in: operationIds } },
          select: {
            id: true,
            operationNo: true,
            type: true,
            status: true,
            sourceStationId: true,
            destinationStationId: true,
            asset: {
              select: {
                id: true,
                assetId: true,
                type: true,
              },
            },
          },
        })
      : [];

    const operationMap = new Map(
      operations.map((operation) => [operation.id, operation]),
    );

    return movements.map((movement) => {
      const operation = movement.referenceId
        ? operationMap.get(movement.referenceId)
        : undefined;

      let relatedEntity = '';
      if (operation?.asset) {
        relatedEntity = operation.asset.assetId || operation.asset.type || '';
      } else if (operation) {
        const relatedStationId =
          movement.stationId === operation.sourceStationId
            ? operation.destinationStationId
            : operation.sourceStationId;
        relatedEntity = relatedStationId || '';
      }

      return {
        ...movement,
        referenceNo:
          operation?.operationNo || movement.referenceId || movement.id,
        referenceStatus: operation?.status || 'COMPLETED',
        relatedEntity,
        operationType: operation?.type || null,
      };
    });
  }

  async getStockMovements(stationId: string) {
    const station = await this.prisma.station.findFirst({
      where: {
        id: stationId,
        deletedAt: null,
      },
      select: {
        id: true,
      },
    });

    if (!station) {
      throw new NotFoundException('Station not found');
    }

    return this.prisma.stationStockMovement.findMany({
      where: {
        stationId,
      },
      orderBy: {
        movementAt: 'desc',
      },
      include: {
        createdBy: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
      },
    });
  }

  async adjustInventory(
    stationId: string,
    body: {
      actualStock: number;
      reason: string;
      movementAt?: string;
      createdByUserId?: string;
    },
  ) {
    // Inventory adjustment represents a real physical stock count.
    // Therefore the user enters actualStock, not a +/- quantity.
    // Negative running balances are allowed from operations only, not from physical stock count.
    const actualStock = Number(body.actualStock);
    if (!Number.isFinite(actualStock) || actualStock < 0) {
      throw new BadRequestException('Actual stock must be a valid zero or positive number');
    }

    if (!body.reason?.trim()) {
      throw new BadRequestException('Inventory adjustment reason is required');
    }

    const permissionStation = await this.prisma.station.findFirst({
      where: {
        id: stationId,
        deletedAt: null,
      },
      include: {
        project: true,
      },
    });

    if (!permissionStation) {
      throw new NotFoundException('Station not found');
    }

    await this.ensureStationActionDirectPermission(
      permissionStation,
      body.createdByUserId,
      'INVENTORY_ADJUSTMENT',
    );

    const movementAt = this.parseOptionalDate(body.movementAt);

    return this.prisma.$transaction(
      async (tx) => {
        const station = await tx.station.findFirst({
          where: {
            id: stationId,
            deletedAt: null,
          },
        });

        if (!station) {
          throw new NotFoundException('Station not found');
        }

        const balanceBefore = Number(station.currentStock || 0);
        const quantity = actualStock - balanceBefore;
        const balanceAfter = actualStock;

        const movement = await tx.stationStockMovement.create({
          data: {
            stationId: station.id,
            companyId: station.companyId,
            movementType: 'PHYSICAL_ADJUSTMENT' as any,
            quantity,
            balanceBefore,
            balanceAfter,
            referenceType: 'PHYSICAL_STOCK_COUNT',
            referenceId: station.id,
            reason: body.reason.trim(),
            movementAt,
            createdByUserId: body.createdByUserId || null,
          },
        });

        const updatedStation = await tx.station.update({
          where: {
            id: station.id,
          },
          data: {
            currentStock: balanceAfter,
          },
          include: {
            company: true,
            project: true,
          },
        });

        return {
          station: updatedStation,
          movement,
          balanceBefore,
          actualStock: balanceAfter,
          adjustmentQuantity: quantity,
        };
      },
      {
        maxWait: 10000,
        timeout: 20000,
      },
    );
  }

  async zeroBalance(
    stationId: string,
    body: {
      reason: string;
      movementAt?: string;
      createdByUserId?: string;
    },
  ) {
    if (!body.reason?.trim()) {
      throw new BadRequestException('Zero balance reason is required');
    }

    const permissionStation = await this.prisma.station.findFirst({
      where: {
        id: stationId,
        deletedAt: null,
      },
      include: {
        project: true,
      },
    });

    if (!permissionStation) {
      throw new NotFoundException('Station not found');
    }

    await this.ensureStationActionDirectPermission(
      permissionStation,
      body.createdByUserId,
      'ZERO_BALANCE',
    );

    const movementAt = this.parseOptionalDate(body.movementAt);

    return this.prisma.$transaction(
      async (tx) => {
        const station = await tx.station.findFirst({
          where: {
            id: stationId,
            deletedAt: null,
          },
        });

        if (!station) {
          throw new NotFoundException('Station not found');
        }

        const balanceBefore = Number(station.currentStock || 0);

        if (balanceBefore === 0) {
          throw new BadRequestException(
            'Current station stock is already zero',
          );
        }

        const quantity = -balanceBefore;
        const balanceAfter = 0;

        const movement = await tx.stationStockMovement.create({
          data: {
            stationId: station.id,
            companyId: station.companyId,
            movementType: 'ZERO_BALANCE' as any,
            quantity,
            balanceBefore,
            balanceAfter,
            referenceType: 'ZERO_BALANCE',
            referenceId: station.id,
            reason: body.reason.trim(),
            movementAt,
            createdByUserId: body.createdByUserId || null,
          },
        });

        const updatedStation = await tx.station.update({
          where: {
            id: station.id,
          },
          data: {
            currentStock: 0,
          },
          include: {
            company: true,
            project: true,
          },
        });

        return {
          station: updatedStation,
          movement,
        };
      },
      {
        maxWait: 10000,
        timeout: 20000,
      },
    );
  }

  async createActionRequest(
    stationId: string,
    body: {
      actionType: string;
      requestedByUserId: string;
      reason: string;
      actualStock?: number;
      newCounter?: number;
      effectiveAt?: string;
      movementAt?: string;
    },
  ) {
    const actionType = String(body.actionType || '')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');

    if (
      !['ZERO_BALANCE', 'INVENTORY_ADJUSTMENT', 'COUNTER_RESET'].includes(
        actionType,
      )
    ) {
      throw new BadRequestException('Unsupported station action request type');
    }

    if (!body.requestedByUserId) {
      throw new BadRequestException('Requester user is required');
    }

    if (!body.reason?.trim()) {
      throw new BadRequestException('Request reason is required');
    }

    const station = await this.prisma.station.findFirst({
      where: {
        id: stationId,
        deletedAt: null,
      },
      include: {
        project: true,
      },
    });

    if (!station) {
      throw new NotFoundException('Station not found');
    }

    if (!station.projectId || !station.project) {
      throw new BadRequestException(
        'Station must be assigned to an active project before submitting this request',
      );
    }

    const requester = await this.getRequester(
      body.requestedByUserId,
      station.companyId,
    );
    const requesterRoleName = requester.role?.name || '';

    if (actionType === 'INVENTORY_ADJUSTMENT') {
      if (!this.isManagerRole(requesterRoleName)) {
        throw new BadRequestException(
          'Only the assigned Project Manager can submit an inventory adjustment request',
        );
      }

      if (station.project.projectManagerId !== body.requestedByUserId) {
        throw new BadRequestException(
          'Only the assigned Project Manager can submit an inventory adjustment request for this station',
        );
      }
    } else {
      if (!this.isOfficerRole(requesterRoleName)) {
        throw new BadRequestException(
          'Only Officer can submit this station action request',
        );
      }

      if (!station.project.projectManagerId) {
        throw new BadRequestException(
          'Station project has no assigned Project Manager',
        );
      }
    }

    let requestedActualStock: number | null = null;
    let requestedCounter: number | null = null;
    let effectiveAt: Date | null = null;
    let movementAt: Date | null = null;

    if (actionType === 'INVENTORY_ADJUSTMENT') {
      requestedActualStock = Number(body.actualStock);
      if (
        !Number.isFinite(requestedActualStock) ||
        requestedActualStock < 0
      ) {
        throw new BadRequestException(
          'Actual stock must be a valid zero or positive number',
        );
      }
      movementAt = body.movementAt
        ? this.parseOptionalDate(body.movementAt)
        : new Date();
    }

    if (actionType === 'ZERO_BALANCE') {
      if (Number(station.currentStock || 0) === 0) {
        throw new BadRequestException('Current station stock is already zero');
      }
      movementAt = body.movementAt
        ? this.parseOptionalDate(body.movementAt)
        : new Date();
    }

    if (actionType === 'COUNTER_RESET') {
      requestedCounter = Number(body.newCounter);
      if (!Number.isFinite(requestedCounter) || requestedCounter < 0) {
        throw new BadRequestException(
          'New counter must be a valid zero or positive number',
        );
      }

      effectiveAt = body.effectiveAt
        ? this.parseOptionalDate(body.effectiveAt)
        : new Date();

      if (effectiveAt.getTime() < station.createdAt.getTime()) {
        throw new BadRequestException(
          'Reset effective date cannot be before the station creation date',
        );
      }

      if (effectiveAt.getTime() > Date.now()) {
        throw new BadRequestException(
          'Reset effective date cannot be in the future',
        );
      }
    }

    const conflictingActionTypes =
      actionType === 'COUNTER_RESET'
        ? ['COUNTER_RESET']
        : ['ZERO_BALANCE', 'INVENTORY_ADJUSTMENT'];

    const existingPending = await this.prisma.stationActionRequest.findFirst({
      where: {
        stationId,
        status: 'PENDING',
        actionType: {
          in: conflictingActionTypes as any,
        },
      },
    });

    if (existingPending) {
      throw new BadRequestException(
        'A pending station action request already exists for this station',
      );
    }

    return this.prisma.stationActionRequest.create({
      data: {
        companyId: station.companyId,
        stationId: station.id,
        projectId: station.projectId,
        requestedByUserId: body.requestedByUserId,
        actionType: actionType as any,
        status: 'PENDING' as any,
        reason: body.reason.trim(),
        requestedActualStock,
        requestedCounter,
        effectiveAt,
        movementAt,
      },
      include: {
        station: {
          include: {
            project: true,
          },
        },
        project: true,
        requestedBy: {
          include: {
            role: true,
          },
        },
        reviewedBy: {
          include: {
            role: true,
          },
        },
      },
    });
  }

  async getActionRequests(
    userId: string,
    status?: string,
  ) {
    if (!userId) {
      throw new BadRequestException('User ID is required');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        deletedAt: null,
        isActive: true,
      },
      include: {
        role: true,
      },
    });

    if (!user) {
      throw new BadRequestException('User is invalid or inactive');
    }

    const roleName = user.role?.name || '';
    const normalizedStatus = String(status || '')
      .trim()
      .toUpperCase();

    if (
      normalizedStatus &&
      !['PENDING', 'PROCESSING', 'APPROVED', 'REJECTED'].includes(
        normalizedStatus,
      )
    ) {
      throw new BadRequestException('Invalid station action request status');
    }

    const visibility: any[] = [
      {
        requestedByUserId: user.id,
      },
    ];

    if (this.isAdminRole(roleName)) {
      visibility.push({
        companyId: user.companyId,
      });
    } else if (this.isManagerRole(roleName)) {
      visibility.push({
        project: {
          is: {
            projectManagerId: user.id,
          },
        },
        actionType: {
          in: ['ZERO_BALANCE', 'COUNTER_RESET'] as any,
        },
      });
    }

    return this.prisma.stationActionRequest.findMany({
      where: {
        companyId: user.companyId,
        ...(normalizedStatus
          ? {
              status: normalizedStatus as any,
            }
          : {}),
        OR: visibility,
      },
      include: {
        station: {
          include: {
            project: true,
          },
        },
        project: true,
        requestedBy: {
          include: {
            role: true,
          },
        },
        reviewedBy: {
          include: {
            role: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async reviewActionRequest(
    requestId: string,
    body: {
      reviewerUserId: string;
      approve: boolean;
      reviewNote?: string;
    },
  ) {
    if (!body.reviewerUserId) {
      throw new BadRequestException('Reviewer user is required');
    }

    const request = await this.prisma.stationActionRequest.findFirst({
      where: {
        id: requestId,
      },
      include: {
        station: {
          include: {
            project: true,
          },
        },
        project: true,
        requestedBy: {
          include: {
            role: true,
          },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('Station action request not found');
    }

    if (request.status !== 'PENDING') {
      throw new BadRequestException('Station action request already reviewed');
    }

    const reviewer = await this.getRequester(
      body.reviewerUserId,
      request.companyId,
    );
    const reviewerRoleName = reviewer.role?.name || '';
    const actionType = String(request.actionType || '').toUpperCase();

    if (actionType === 'INVENTORY_ADJUSTMENT') {
      if (!this.isAdminRole(reviewerRoleName)) {
        throw new BadRequestException(
          'Only Admin can review an inventory adjustment request',
        );
      }
    } else {
      if (!this.isManagerRole(reviewerRoleName)) {
        throw new BadRequestException(
          'Only the assigned Project Manager can review this station request',
        );
      }

      const assignedManagerId =
        request.station?.project?.projectManagerId ||
        request.project?.projectManagerId ||
        null;

      if (!assignedManagerId || assignedManagerId !== body.reviewerUserId) {
        throw new BadRequestException(
          'Only the assigned Project Manager can review this station request',
        );
      }
    }

    const now = new Date();
    const reviewNote = String(body.reviewNote || '').trim();

    if (!body.approve) {
      return this.prisma.$transaction(
        async (tx) => {
          const claimed = await tx.stationActionRequest.updateMany({
            where: {
              id: requestId,
              status: 'PENDING' as any,
            },
            data: {
              status: 'REJECTED' as any,
              reviewedByUserId: body.reviewerUserId,
              reviewNote: reviewNote || 'Rejected',
              reviewedAt: now,
              rejectedAt: now,
            },
          });

          if (claimed.count !== 1) {
            throw new BadRequestException(
              'Station action request already reviewed',
            );
          }

          return tx.stationActionRequest.findUnique({
            where: {
              id: requestId,
            },
            include: {
              station: {
                include: {
                  project: true,
                },
              },
              project: true,
              requestedBy: {
                include: {
                  role: true,
                },
              },
              reviewedBy: {
                include: {
                  role: true,
                },
              },
            },
          });
        },
        { maxWait: 5000, timeout: 20000 },
      );
    }

    return this.prisma.$transaction(
      async (tx) => {
        const claimed = await tx.stationActionRequest.updateMany({
          where: {
            id: requestId,
            status: 'PENDING' as any,
          },
          data: {
            status: 'PROCESSING' as any,
            reviewedByUserId: body.reviewerUserId,
            reviewNote: reviewNote || 'Approved',
            reviewedAt: now,
          },
        });

        if (claimed.count !== 1) {
          throw new BadRequestException(
            'Station action request already reviewed',
          );
        }

        const station = await tx.station.findFirst({
          where: {
            id: request.stationId,
            deletedAt: null,
          },
        });

        if (!station) {
          throw new NotFoundException('Station not found');
        }

        let actionResult: any = null;

        if (actionType === 'ZERO_BALANCE') {
          const balanceBefore = Number(station.currentStock || 0);

          if (balanceBefore === 0) {
            throw new BadRequestException(
              'Current station stock is already zero',
            );
          }

          const movementAt = request.movementAt || now;
          const quantity = -balanceBefore;

          const movement = await tx.stationStockMovement.create({
            data: {
              stationId: station.id,
              companyId: station.companyId,
              movementType: 'ZERO_BALANCE' as any,
              quantity,
              balanceBefore,
              balanceAfter: 0,
              referenceType: 'STATION_ACTION_REQUEST',
              referenceId: request.id,
              reason: request.reason,
              movementAt,
              createdByUserId: body.reviewerUserId,
            },
          });

          const updatedStation = await tx.station.update({
            where: {
              id: station.id,
            },
            data: {
              currentStock: 0,
            },
            include: {
              company: true,
              project: true,
            },
          });

          actionResult = {
            station: updatedStation,
            movement,
            balanceBefore,
            balanceAfter: 0,
          };
        } else if (actionType === 'INVENTORY_ADJUSTMENT') {
          const actualStock = Number(request.requestedActualStock);

          if (!Number.isFinite(actualStock) || actualStock < 0) {
            throw new BadRequestException(
              'Requested actual stock is invalid',
            );
          }

          const balanceBefore = Number(station.currentStock || 0);
          const quantity = actualStock - balanceBefore;
          const movementAt = request.movementAt || now;

          const movement = await tx.stationStockMovement.create({
            data: {
              stationId: station.id,
              companyId: station.companyId,
              movementType: 'PHYSICAL_ADJUSTMENT' as any,
              quantity,
              balanceBefore,
              balanceAfter: actualStock,
              referenceType: 'STATION_ACTION_REQUEST',
              referenceId: request.id,
              reason: request.reason,
              movementAt,
              createdByUserId: body.reviewerUserId,
            },
          });

          const updatedStation = await tx.station.update({
            where: {
              id: station.id,
            },
            data: {
              currentStock: actualStock,
            },
            include: {
              company: true,
              project: true,
            },
          });

          actionResult = {
            station: updatedStation,
            movement,
            balanceBefore,
            actualStock,
            adjustmentQuantity: quantity,
          };
        } else if (actionType === 'COUNTER_RESET') {
          const newCounter = Number(request.requestedCounter);

          if (!Number.isFinite(newCounter) || newCounter < 0) {
            throw new BadRequestException(
              'Requested counter value is invalid',
            );
          }

          const effectiveAt = request.effectiveAt || now;

          if (effectiveAt.getTime() < station.createdAt.getTime()) {
            throw new BadRequestException(
              'Reset effective date cannot be before the station creation date',
            );
          }

          if (effectiveAt.getTime() > now.getTime()) {
            throw new BadRequestException(
              'Reset effective date cannot be in the future',
            );
          }

          const resetRecord = await tx.stationCounterReset.create({
            data: {
              stationId: station.id,
              companyId: station.companyId,
              oldCounter: Number(station.currentCounter || 0),
              newCounter,
              lifetimeAtReset: this.getEffectiveStationLifetime(station),
              oldCounterCycle: Number(station.currentCounterCycle || 1),
              newCounterCycle: Number(station.currentCounterCycle || 1) + 1,
              reason: request.reason,
              effectiveAt,
              createdByUserId: body.reviewerUserId,
            },
          });

          await this.rebuildStationLifetimeHistory(tx, station.id);

          const [updatedStation, rebuiltResetRecord] = await Promise.all([
            tx.station.findUnique({
              where: {
                id: station.id,
              },
              include: {
                company: true,
                project: true,
              },
            }),
            tx.stationCounterReset.findUnique({
              where: {
                id: resetRecord.id,
              },
            }),
          ]);

          actionResult = {
            station: updatedStation,
            resetRecord: rebuiltResetRecord,
          };
        } else {
          throw new BadRequestException(
            'Unsupported station action request type',
          );
        }

        const updatedRequest = await tx.stationActionRequest.update({
          where: {
            id: requestId,
          },
          data: {
            status: 'APPROVED' as any,
            approvedAt: now,
            appliedAt: now,
          },
          include: {
            station: {
              include: {
                project: true,
              },
            },
            project: true,
            requestedBy: {
              include: {
                role: true,
              },
            },
            reviewedBy: {
              include: {
                role: true,
              },
            },
          },
        });

        return {
          request: updatedRequest,
          result: actionResult,
        };
      },
      { maxWait: 5000, timeout: 20000 },
    );
  }

  async createTransferRequest(
    stationId: string,
    toProjectId: string,
    requestedByUserId: string,
    effectiveDate?: string,
  ) {
    // Kept in the method signature for backward API compatibility.
    // Station transfers now become effective only at final approval time.
    void effectiveDate;

    const station = await this.prisma.station.findFirst({
      where: {
        id: stationId,
        deletedAt: null,
      },
      include: {
        project: true,
      },
    });

    if (!station) {
      throw new NotFoundException('Station not found');
    }

    if (!station.projectId) {
      throw new BadRequestException('Station has no current project');
    }

    if (station.projectId === toProjectId) {
      throw new BadRequestException('Station already belongs to this project');
    }

    const targetProject = await this.prisma.project.findFirst({
      where: {
        id: toProjectId,
        deletedAt: null,
        isActive: true,
        companyId: station.companyId,
      },
    });

    if (!targetProject) {
      throw new BadRequestException('Target project is invalid');
    }

    const requester = await this.getRequester(
      requestedByUserId,
      station.companyId,
    );

    const requesterRoleName = requester.role?.name || '';

    if (this.isAdminRole(requesterRoleName)) {
      throw new BadRequestException(
        'Admin cannot create station transfer requests',
      );
    }

    if (
      !this.isOfficerRole(requesterRoleName) &&
      !this.isManagerRole(requesterRoleName)
    ) {
      throw new BadRequestException(
        'Only Officer or Manager can create station transfer requests',
      );
    }

    if (!station.project?.projectManagerId || !targetProject.projectManagerId) {
      throw new BadRequestException(
        'Station transfer requires source and destination project managers',
      );
    }

    const pending = await this.prisma.stationTransferRequest.findFirst({
      where: {
        stationId,
        status: {
          in: ['PENDING', 'PARTIALLY_APPROVED'],
        },
      },
    });

    if (pending) {
      throw new BadRequestException('Pending transfer already exists');
    }

    const now = new Date();

    const approvers = this.buildUniqueApprovers([
      {
        approverUserId: station.project.projectManagerId,
        projectId: station.projectId,
        approvalStage: 'Source Project Manager',
      },
      {
        approverUserId: targetProject.projectManagerId,
        projectId: targetProject.id,
        approvalStage: 'Destination Project Manager',
      },
    ]);

    const approvalsToCreate = approvers.map((approver) => {
      const requesterIsThisProjectManager =
        approver.approverUserId === requestedByUserId;

      return {
        approverUserId: approver.approverUserId,
        projectId: approver.projectId,
        approvalStage: approver.approvalStage,
        status: requesterIsThisProjectManager ? 'APPROVED' : 'PENDING',
        reviewedAt: requesterIsThisProjectManager ? now : null,
        note: requesterIsThisProjectManager
          ? 'Auto-approved because the requester is this project manager'
          : null,
      };
    });

    const fullyApproved = approvalsToCreate.every(
      (approval) => approval.status === 'APPROVED',
    );

    const partiallyApproved = approvalsToCreate.some(
      (approval) => approval.status === 'APPROVED',
    );

    return this.prisma.$transaction(async (tx) => {
      const transferRequest = await tx.stationTransferRequest.create({
        data: {
          companyId: station.companyId,
          stationId: station.id,
          fromProjectId: station.projectId!,
          toProjectId,
          requestedByUserId,
          stockAtTransfer: Number(station.currentStock || 0),
          effectiveDate: null,
          status: fullyApproved
            ? 'APPROVED'
            : partiallyApproved
              ? 'PARTIALLY_APPROVED'
              : 'PENDING',
          ...(fullyApproved
            ? {
                approvedAt: now,
                appliedAt: now,
                reason: 'Auto-applied because the requester manages all required approval stages',
              }
            : partiallyApproved
              ? {
                  reason: 'Partially auto-approved because the requester manages one required approval stage',
                }
              : {}),
          approvals: {
            create: approvalsToCreate.map((approval) => ({
              approverUserId: approval.approverUserId,
              projectId: approval.projectId,
              approvalStage: approval.approvalStage,
              status: approval.status as any,
              reviewedAt: approval.reviewedAt,
              note: approval.note,
            })),
          },
        },
        include: {
          station: true,
          fromProject: true,
          toProject: true,
          approvals: true,
        },
      });

      if (!fullyApproved) {
        return transferRequest;
      }

      await tx.station.update({
        where: {
          id: station.id,
        },
        data: {
          projectId: toProjectId,
        },
      });

      await tx.stationAssignmentHistory.create({
        data: {
          companyId: station.companyId,
          stationId: station.id,
          fromProjectId: station.projectId,
          toProjectId,
          transferRequestId: transferRequest.id,
          assignmentType: 'TRANSFER' as any,
          reason: 'Station transfer auto-approved and applied',
          assignedAt: now,
          assignedByUserId: requestedByUserId,
        },
      });

      return tx.stationTransferRequest.findFirst({
        where: {
          id: transferRequest.id,
        },
        include: {
          station: true,
          fromProject: true,
          toProject: true,
          approvals: true,
        },
      });
    }, {
      maxWait: 10000,
      timeout: 20000,
    });
  }

  async getTransferReport(filters: {
    companyId?: string;
    fromProjectId?: string;
    toProjectId?: string;
    stationId?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const dateFrom = filters.dateFrom
      ? this.parseOptionalDate(filters.dateFrom)
      : undefined;
    const dateTo = filters.dateTo
      ? this.parseOptionalDate(filters.dateTo)
      : undefined;

    if (dateTo) {
      dateTo.setHours(23, 59, 59, 999);
    }

    if (dateFrom && dateTo && dateFrom.getTime() > dateTo.getTime()) {
      throw new BadRequestException('Date from cannot be after date to');
    }

    const normalizedStatus = String(filters.status || 'ALL')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');

    const allowedStatuses = [
      'ALL',
      'PENDING',
      'PARTIALLY_APPROVED',
      'APPROVED',
      'REJECTED',
    ];

    if (!allowedStatuses.includes(normalizedStatus)) {
      throw new BadRequestException(
        'Status must be ALL, PENDING, PARTIALLY_APPROVED, APPROVED, or REJECTED',
      );
    }

    const transferRequests = await this.prisma.stationTransferRequest.findMany({
      where: {
        ...(filters.companyId ? { companyId: filters.companyId } : {}),
        ...(filters.fromProjectId
          ? { fromProjectId: filters.fromProjectId }
          : {}),
        ...(filters.toProjectId ? { toProjectId: filters.toProjectId } : {}),
        ...(filters.stationId ? { stationId: filters.stationId } : {}),
        ...(normalizedStatus !== 'ALL'
          ? { status: normalizedStatus as any }
          : {}),
        ...(dateFrom || dateTo
          ? {
              createdAt: {
                ...(dateFrom ? { gte: dateFrom } : {}),
                ...(dateTo ? { lte: dateTo } : {}),
              },
            }
          : {}),
      },
      include: {
        station: {
          select: {
            id: true,
            stationId: true,
            name: true,
            deletedAt: true,
          },
        },
        fromProject: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        toProject: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        approvals: {
          orderBy: [
            { reviewedAt: 'asc' },
            { createdAt: 'asc' },
          ],
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const userIds = Array.from(
      new Set(
        transferRequests.flatMap((request) => [
          request.requestedByUserId,
          ...request.approvals
            .filter((approval) => approval.status === 'APPROVED')
            .map((approval) => approval.approverUserId),
        ]),
      ),
    );

    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: {
            id: { in: userIds },
          },
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        })
      : [];

    const userMap = new Map(users.map((user) => [user.id, user]));

    const rows = transferRequests.map((request) => {
      const approvedBy = request.approvals
        .filter((approval) => approval.status === 'APPROVED')
        .map((approval) => userMap.get(approval.approverUserId))
        .filter(Boolean);

      return {
        transferRef: request.id,
        requestDate: request.createdAt,
        station: request.station,
        fromProject: request.fromProject,
        toProject: request.toProject,
        stockAtTransfer: Number(request.stockAtTransfer || 0),
        transferDate: request.appliedAt || request.approvedAt,
        requestedBy: userMap.get(request.requestedByUserId) || null,
        approvedBy,
        status: request.status,
        approvedAt: request.approvedAt,
        rejectedAt: request.rejectedAt,
        rejectionReason: request.rejectionReason,
      };
    });

    const summary = rows.reduce(
      (result, row) => {
        result.totalTransfers += 1;

        if (
          row.status === 'PENDING' ||
          row.status === 'PARTIALLY_APPROVED'
        ) {
          result.pending += 1;
        } else if (row.status === 'APPROVED') {
          result.approved += 1;
        } else if (row.status === 'REJECTED') {
          result.rejected += 1;
        }

        return result;
      },
      {
        totalTransfers: 0,
        pending: 0,
        approved: 0,
        rejected: 0,
      },
    );

    return {
      summary,
      rows,
    };
  }

  async getPendingTransferRequests() {
    return this.prisma.stationTransferRequest.findMany({
      where: {
        status: {
          in: ['PENDING', 'PARTIALLY_APPROVED'],
        },
      },
      include: {
        station: true,
        fromProject: true,
        toProject: true,
        approvals: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async reviewTransfer(
    transferId: string,
    managerUserId: string,
    approve: boolean,
    rejectionReason?: string,
  ) {
    const request = await this.prisma.stationTransferRequest.findFirst({
      where: {
        id: transferId,
      },
      include: {
        station: true,
        fromProject: true,
        toProject: true,
        approvals: true,
      },
    });

    if (!request) {
      throw new NotFoundException('Station transfer request not found');
    }

    if (!['PENDING', 'PARTIALLY_APPROVED'].includes(request.status)) {
      throw new BadRequestException('Transfer already reviewed');
    }

    const now = new Date();

    const pendingApproval = request.approvals.find(
      (approval) =>
        approval.approverUserId === managerUserId &&
        approval.status === 'PENDING',
    );

    if (!pendingApproval) {
      throw new BadRequestException('User cannot approve this station transfer');
    }

    if (!approve) {
      return this.prisma.$transaction(
        async (tx) => {
          await tx.stationTransferApproval.update({
          where: {
            id: pendingApproval.id,
          },
          data: {
            status: 'REJECTED',
            note: rejectionReason || 'Rejected',
            reviewedAt: now,
          },
        });

        return tx.stationTransferRequest.update({
          where: {
            id: transferId,
          },
          data: {
            status: 'REJECTED',
            rejectedAt: now,
            rejectionReason: rejectionReason || 'Rejected',
          },
          include: {
            station: true,
            fromProject: true,
            toProject: true,
            approvals: true,
          },
        });
        },
        { timeout: 15000 },
      );
    }

    return this.prisma.$transaction(
      async (tx) => {
      await tx.stationTransferApproval.update({
        where: {
          id: pendingApproval.id,
        },
        data: {
          status: 'APPROVED',
          reviewedAt: new Date(),
        },
      });

      const approvals = await tx.stationTransferApproval.findMany({
        where: {
          transferRequestId: transferId,
        },
      });

      const fullyApproved = approvals.every(
        (approval) => approval.status === 'APPROVED',
      );

      if (!fullyApproved) {
        return tx.stationTransferRequest.update({
          where: {
            id: transferId,
          },
          data: {
            status: 'PARTIALLY_APPROVED',
            reason: `First approval by manager ${managerUserId}`,
          },
          include: {
            station: true,
            fromProject: true,
            toProject: true,
            approvals: true,
          },
        });
      }

      await tx.station.update({
        where: {
          id: request.stationId,
        },
        data: {
          projectId: request.toProjectId,
        },
      });

      await tx.stationAssignmentHistory.create({
        data: {
          companyId: request.companyId,
          stationId: request.stationId,
          fromProjectId: request.fromProjectId,
          toProjectId: request.toProjectId,
          transferRequestId: request.id,
          assignmentType: 'TRANSFER' as any,
          reason: 'Station transfer approved and applied',
          assignedAt: now,
          assignedByUserId: managerUserId,
        },
      });

      return tx.stationTransferRequest.update({
        where: {
          id: transferId,
        },
        data: {
          status: 'APPROVED',
          approvedAt: now,
          appliedAt: now,
          reason: request.reason
            ? `${request.reason}; Final approval by manager ${managerUserId}`
            : `Approved by manager ${managerUserId}`,
        },
        include: {
          station: true,
          fromProject: true,
          toProject: true,
          approvals: true,
        },
      });
      },
      { timeout: 15000 },
    );
  }

  async hardDelete(id: string) {
    const station = await this.prisma.station.findFirst({
      where: {
        id,
      },
      select: {
        id: true,
      },
    });

    if (!station) {
      throw new NotFoundException('Station not found');
    }

    return this.prisma.$transaction(async (tx) => {
      const transferRequests = await tx.stationTransferRequest.findMany({
        where: {
          stationId: id,
        },
        select: {
          id: true,
        },
      });

      const transferRequestIds = transferRequests.map((item) => item.id);

      if (transferRequestIds.length) {
        await tx.stationTransferApproval.deleteMany({
          where: {
            transferRequestId: {
              in: transferRequestIds,
            },
          },
        });
      }

      await tx.stationAssignmentHistory.deleteMany({
        where: {
          stationId: id,
        },
      });

      await tx.stationTransferRequest.deleteMany({
        where: {
          stationId: id,
        },
      });

      await tx.stationActionRequest.deleteMany({
        where: {
          stationId: id,
        },
      });

      await tx.stationStockMovement.deleteMany({
        where: {
          stationId: id,
        },
      });

      await tx.stationCounterReset.deleteMany({
        where: {
          stationId: id,
        },
      });


      return tx.station.delete({
        where: {
          id,
        },
      });
    });
  }

  async remove(id: string) {
    const station = await this.prisma.station.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!station) {
      throw new NotFoundException('Station not found');
    }

    const currentStock = Number(station.currentStock);

    if (!Number.isFinite(currentStock)) {
      throw new BadRequestException(
        'Station stock could not be verified. Please correct the station balance before deletion.',
      );
    }

    if (Math.abs(currentStock) > 0.000001) {
      throw new BadRequestException(
        `Cannot delete station ${station.stationId} because its current stock is ${currentStock} liters. Adjust the balance to zero before deletion.`,
      );
    }

    return this.prisma.station.update({
      where: {
        id,
      },
      data: {
        deletedAt: new Date(),
        status: 'INACTIVE' as any,
      },
    });
  }
}
