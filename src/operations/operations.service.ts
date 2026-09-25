import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOperationDto } from './dto/create-operation.dto';
import { ReviewOperationDto } from './dto/review-operation.dto';
import { OperationsRealtimeService } from './operations-realtime.service';
import { NotificationsService } from '../notifications/notifications.service';

type NormalizedOperationType =
  | 'DIRECT_REFUEL'
  | 'EXTERNAL_DIRECT_REFUEL'
  | 'INTERNAL_TRANSFER'
  | 'EXTERNAL_SUPPLY'
  | 'EXTERNAL_TRANSFER';

type NormalizedRole =
  | 'PlatformAdmin'
  | 'TopManagement'
  | 'Admin'
  | 'Manager'
  | 'Supervisor'
  | 'Officer'
  | 'Operator';

type OperationDecisionStatus =
  | 'PENDING'
  | 'PARTIALLY_APPROVED'
  | 'COMPLETED';

type RequestLike = {
  user?: any;
  headers?: Record<string, any>;
};

type CurrentUserContext = {
  id: string;
  fullName: string;
  role: NormalizedRole;
  companyId?: string;
  existsInDatabase: boolean;
  assignedProjectIds: string[];
  managedProjectIds: string[];
  fuelerEmployeeId: string | null;
  fuelerName: string;
};

type OperationDispenserReadingInput = { stationId: string; counter: number };
type OperationDispenserAllocationInput = { stationId: string; quantity: number };

type LoadedOperationEntities = {
  sourceStation?: any;
  destinationStation?: any;
  asset?: any;
  sourceInventoryStation?: any;
  destinationInventoryStation?: any;
  sourceProjectId?: string | null;
  destinationProjectId?: string | null;
  assetProjectId?: string | null;
  sourceProjectAtOperation?: any;
  destinationProjectAtOperation?: any;
  assetProjectAtOperation?: any;
};

type ApprovalPlanItem = {
  approverUserId: string;
  projectId: string;
  approvalStage: string;
  status: 'PENDING' | 'APPROVED';
  reviewedAt?: Date | null;
};

type OperationMeterSnapshot = {
  lifetimeOdometer: number | null;
  assetMeterCycleNumber: number | null;
  lifetimeCounter: number | null;
  stationCounterCycleNumber: number | null;
};

type OperationProjectSnapshot = {
  projectIdAtOperation: string | null;
  projectNameAtOperation: string | null;
  sourceProjectIdAtOperation: string | null;
  sourceProjectNameAtOperation: string | null;
  destinationProjectIdAtOperation: string | null;
  destinationProjectNameAtOperation: string | null;
};

type OperationLocationSnapshot = {
  locationLatitude: number | null;
  locationLongitude: number | null;
  locationAccuracy: number | null;
  locationCapturedAt: Date | null;
};

@Injectable()
export class OperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operationsRealtime: OperationsRealtimeService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private buildOperationListInclude() {
    return {
      requestedBy: {
        select: {
          id: true,
          fullName: true,
          employeeId: true,
          linkedEmployee: {
            select: { employeeId: true, name: true },
          },
        },
      },

      dispenserAllocations: {
        select: {
          id: true,
          stationId: true,
          quantity: true,
          createdAt: true,
          station: {
            select: {
              id: true,
              stationId: true,
              name: true,
              status: true,
              structureType: true,
              parentStationId: true,
            },
          },
        },
        orderBy: [{ createdAt: 'asc' }],
      },

      stationCounterReadings: {
        select: {
          id: true,
          stationId: true,
          counterValue: true,
          lifetimeCounter: true,
          counterCycleNumber: true,
          counterBefore: true,
          counterAfter: true,
          lifetimeBefore: true,
          lifetimeAfter: true,
          counterCycleBefore: true,
          counterCycleAfter: true,
          createdAt: true,
          station: {
            select: {
              id: true,
              stationId: true,
              name: true,
              status: true,
              structureType: true,
              parentStationId: true,
            },
          },
        },
        orderBy: [{ createdAt: 'asc' }],
      },

      approvals: {
        select: {
          id: true,
          approverUserId: true,
          projectId: true,
          approvalStage: true,
          status: true,
          note: true,
          reviewedAt: true,
          createdAt: true,
          approver: {
            select: {
              id: true,
              fullName: true,
            },
          },
        },
      },

      sourceStation: {
        select: {
          id: true,
          stationId: true,
          name: true,
          projectId: true,
          structureType: true,
          parentStationId: true,
        },
      },

      destinationStation: {
        select: {
          id: true,
          stationId: true,
          name: true,
          projectId: true,
          structureType: true,
          parentStationId: true,
        },
      },

      asset: {
        select: {
          id: true,
          assetId: true,
          type: true,
          category: true,
          projectId: true,
          currentOdometer: true,
          currentLifetimeOdometer: true,
          currentMeterCycle: true,
          fuelTankCapacity: true,
        },
      },
    };
  }

  async getRealtimeAccessContext(request?: RequestLike) {
    const currentUser = await this.resolveAuthenticatedCurrentUser(request);

    if (!currentUser.companyId) {
      throw new UnauthorizedException(
        'Authenticated user company was not found.',
      );
    }

    return {
      userId: currentUser.id,
      companyId: currentUser.companyId,
    };
  }

  async create(dto: CreateOperationDto, request?: RequestLike) {
    /*
      Mobile/Web production create path:
      identity, role, and company must come from the authenticated JWT request.
      Never trust requestedByUserId / requestedByRole / requestedByName / companyId
      supplied by the client body for persisted operations.
    */
    const currentUser = await this.resolveAuthenticatedCurrentUser(request);
    const type = this.normalizeOperationType(dto.type);

    this.validateRoleCanCreateAnyOperation(currentUser);
    this.validateRoleCanCreateOperationType(currentUser, type);

    /*
      Idempotency must be checked before photo-draft validation.
      A retry may arrive after the first request already consumed the drafts,
      so rerunning the normal create path would incorrectly fail.
    */
    const existingOperation = await this.findExistingIdempotentOperation(
      dto,
      currentUser,
      type,
    );

    if (existingOperation) {
      return this.buildIdempotentCreateResponse(existingOperation, currentUser);
    }

    this.validateRequiredFieldsByType(type, dto);
    this.validateRequiredPhotosByType(type, dto.attachments);

    return this.createPersistedOperation(dto, currentUser, type);
  }


  async getMobileFormContext(
    projectId: string,
    request?: RequestLike,
  ) {
    const currentUser = await this.resolveAuthenticatedCurrentUser(request);

    this.validateRoleCanCreateAnyOperation(currentUser);

    const selectedProjectId = String(projectId || '').trim();
    if (!selectedProjectId) {
      throw new BadRequestException(
        'projectId is required for mobile operation context.',
      );
    }

    if (!currentUser.companyId) {
      throw new UnauthorizedException(
        'Authenticated user company was not found.',
      );
    }

    if (currentUser.role === 'Manager') {
      if (!currentUser.managedProjectIds.includes(selectedProjectId)) {
        throw new ForbiddenException(
          'Manager can create operations for managed projects only.',
        );
      }
    } else if (
      ['Operator', 'Supervisor'].includes(currentUser.role) &&
      !currentUser.assignedProjectIds.includes(selectedProjectId)
    ) {
      throw new ForbiddenException(
        'Selected project is not assigned to this user.',
      );
    }

    const project = await (this.prisma as any).project.findFirst({
      where: {
        id: selectedProjectId,
        companyId: currentUser.companyId,
        deletedAt: null,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        code: true,
      },
    });

    const companyMobileSettings = await (this.prisma as any).company.findFirst({
      where: {
        id: currentUser.companyId,
        deletedAt: null,
      },
      select: {
        mobilePhotoSourcePolicy: true,
        saveCapturedPhotosToDeviceGallery: true,
        stationNegativeTolerancePercent: true,
      },
    });

    if (!companyMobileSettings) {
      throw new NotFoundException(
        'Authenticated company was not found.',
      );
    }

    if (!project) {
      throw new NotFoundException(
        'Selected active project was not found.',
      );
    }

    const [
      projectStationsRaw,
      projectAssetsRaw,
      externalSourceHistoryRaw,
    ] = await Promise.all([
      (this.prisma as any).station.findMany({
        where: {
          companyId: currentUser.companyId,
          projectId: selectedProjectId,
          deletedAt: null,
        },
        select: {
          id: true,
          stationId: true,
          name: true,
          status: true,
          projectId: true,
          currentStock: true,
          currentCounter: true,
          currentLifetimeCounter: true,
          currentCounterCycle: true,
          capacity: true,
          structureType: true,
          parentStationId: true,
          parentStation: {
            select: {
              id: true,
              stationId: true,
              name: true,
              status: true,
              structureType: true,
              projectId: true,
              currentStock: true,
              capacity: true,
            },
          },
          dispensers: {
            where: { deletedAt: null },
            orderBy: [{ stationId: 'asc' }],
            select: {
              id: true,
              stationId: true,
              name: true,
              status: true,
              structureType: true,
              parentStationId: true,
              currentCounter: true,
              currentLifetimeCounter: true,
              currentCounterCycle: true,
            },
          },
        },
        orderBy: [{ stationId: 'asc' }, { name: 'asc' }],
      }),
      (this.prisma as any).asset.findMany({
        where: {
          companyId: currentUser.companyId,
          projectId: selectedProjectId,
          deletedAt: null,
        },
        select: {
          id: true,
          assetId: true,
          type: true,
          category: true,
          status: true,
          projectId: true,
          currentOdometer: true,
          currentLifetimeOdometer: true,
          currentMeterCycle: true,
          fuelTankCapacity: true,
        },
        orderBy: [{ assetId: 'asc' }],
      }),
      (this.prisma as any).operation.findMany({
        where: {
          companyId: currentUser.companyId,
          type: {
            in: ['EXTERNAL_DIRECT_REFUEL', 'EXTERNAL_SUPPLY'],
          },
          externalStationName: {
            not: null,
          },
        },
        select: {
          type: true,
          externalStationName: true,
        },
        orderBy: [{ createdAt: 'desc' }],
      }),
    ]);

    const isActiveStatus = (value: any) =>
      String(value || '').trim().toLowerCase() === 'active';

    const buildExternalSourceHistory = (
      operationType: 'EXTERNAL_DIRECT_REFUEL' | 'EXTERNAL_SUPPLY',
    ) => {
      const seen = new Set<string>();

      return externalSourceHistoryRaw
        .filter(
          (operation: any) =>
            this.normalizeOperationType(operation.type) === operationType,
        )
        .map((operation: any) =>
          String(operation.externalStationName || '').trim(),
        )
        .filter((name: string) => {
          if (!name) return false;

          const key = name.toLowerCase();
          if (seen.has(key)) return false;

          seen.add(key);
          return true;
        })
        .sort((a: string, b: string) => a.localeCompare(b));
    };

    const externalStationHistory = buildExternalSourceHistory(
      'EXTERNAL_DIRECT_REFUEL',
    );
    const externalSupplierHistory =
      buildExternalSourceHistory('EXTERNAL_SUPPLY');

    const stations = projectStationsRaw
      .filter(
        (station: any) =>
          isActiveStatus(station.status) &&
          (String(station.structureType || 'STANDALONE').toUpperCase() !== 'DISPENSER' ||
            (isActiveStatus(station.parentStation?.status) &&
              String(station.parentStation?.structureType || '').toUpperCase() === 'SHARED_TANK')),
      )
      .map((station: any) => ({
        id: station.id,
        stationId: station.stationId,
        name: station.name,
        projectId: station.projectId,
        projectName: project.name,
        projectCode: project.code,
        structureType: station.structureType || 'STANDALONE',
        parentStationId: station.parentStationId || null,
        parentStation: station.parentStation || null,
        dispensers: (station.dispensers || [])
          .filter((item: any) => isActiveStatus(item.status))
          .map((item: any) => ({
            ...item,
            currentCounter: Number(item.currentCounter || 0),
            currentLifetimeCounter: Number(item.currentLifetimeCounter || 0),
            currentCounterCycle: Number(item.currentCounterCycle || 1),
          })),
        currentStock: Number(station.currentStock || 0),
        currentCounter: Number(station.currentCounter || 0),
        currentLifetimeCounter: Number(
          station.currentLifetimeCounter || 0,
        ),
        currentCounterCycle: Number(station.currentCounterCycle || 1),
        capacity:
          station.capacity == null ? null : Number(station.capacity),
      }));

    const assets = projectAssetsRaw
      .filter((asset: any) => isActiveStatus(asset.status))
      .map((asset: any) => ({
        id: asset.id,
        assetId: asset.assetId,
        type: asset.type,
        category: asset.category,
        projectId: asset.projectId,
        projectName: project.name,
        projectCode: project.code,
        currentOdometer: Number(asset.currentOdometer || 0),
        currentLifetimeOdometer: Number(
          asset.currentLifetimeOdometer || 0,
        ),
        currentMeterCycle: Number(asset.currentMeterCycle || 1),
        fuelTankCapacity:
          asset.fuelTankCapacity == null
            ? null
            : Number(asset.fuelTankCapacity),
      }));

    let externalTransferDestinations: any[] = [];

    if (['Supervisor', 'Manager'].includes(currentUser.role)) {
      /*
        External Transfer destination is intentionally outside the selected
        source project. Supervisor/Manager may choose any active station from
        another active project in the same company; approval rules protect the
        destination project.
      */
      {
        const destinationStationsRaw =
          await (this.prisma as any).station.findMany({
            where: {
              companyId: currentUser.companyId,
              deletedAt: null,
              projectId: { not: selectedProjectId },
            },
            select: {
              id: true,
              stationId: true,
              name: true,
              status: true,
              projectId: true,
              currentStock: true,
              currentCounter: true,
              currentLifetimeCounter: true,
              currentCounterCycle: true,
              capacity: true,
              structureType: true,
              parentStationId: true,
              parentStation: {
                select: {
                  id: true,
                  stationId: true,
                  name: true,
                  status: true,
                  structureType: true,
                  projectId: true,
                  currentStock: true,
                  capacity: true,
                },
              },
              dispensers: {
                where: { deletedAt: null },
                orderBy: [{ stationId: 'asc' }],
                select: {
                  id: true,
                  stationId: true,
                  name: true,
                  status: true,
                  structureType: true,
                  parentStationId: true,
                  currentCounter: true,
                  currentLifetimeCounter: true,
                  currentCounterCycle: true,
                },
              },
              project: {
                select: {
                  id: true,
                  name: true,
                  code: true,
                  isActive: true,
                  deletedAt: true,
                },
              },
            },
            orderBy: [{ stationId: 'asc' }, { name: 'asc' }],
          });

        externalTransferDestinations = destinationStationsRaw
          .filter(
            (station: any) =>
              isActiveStatus(station.status) &&
              station.project?.isActive === true &&
              !station.project?.deletedAt,
          )
          .map((station: any) => ({
            id: station.id,
            stationId: station.stationId,
            name: station.name,
            projectId: station.projectId,
            projectName: station.project?.name || '',
            projectCode: station.project?.code || '',
            structureType: station.structureType || 'STANDALONE',
            parentStationId: station.parentStationId || null,
            parentStation: station.parentStation || null,
            dispensers: (station.dispensers || [])
              .filter((item: any) => isActiveStatus(item.status))
              .map((item: any) => ({
                ...item,
                currentCounter: Number(item.currentCounter || 0),
                currentLifetimeCounter: Number(item.currentLifetimeCounter || 0),
                currentCounterCycle: Number(item.currentCounterCycle || 1),
              })),
            currentStock: Number(station.currentStock || 0),
            currentCounter: Number(station.currentCounter || 0),
            currentLifetimeCounter: Number(
              station.currentLifetimeCounter || 0,
            ),
            currentCounterCycle: Number(
              station.currentCounterCycle || 1,
            ),
            capacity:
              station.capacity == null
                ? null
                : Number(station.capacity),
          }));
      }
    }

    const allowedTransactionTypes: NormalizedOperationType[] =
      currentUser.role === 'Operator'
        ? ['DIRECT_REFUEL']
        : currentUser.role === 'Supervisor' ||
            currentUser.role === 'Manager'
          ? [
              'DIRECT_REFUEL',
              'EXTERNAL_DIRECT_REFUEL',
              'INTERNAL_TRANSFER',
              'EXTERNAL_SUPPLY',
              'EXTERNAL_TRANSFER',
            ]
          : [];

    return {
      project,
      user: {
        id: currentUser.id,
        name: currentUser.fullName,
        role: currentUser.role,
        fuelerEmployeeId: currentUser.fuelerEmployeeId,
        fuelerName: currentUser.fuelerName,
      },
      allowedTransactionTypes,
      stations,
      assets,
      externalTransferDestinations,
      externalStationHistory,
      externalSupplierHistory,
      mobileApplicationSettings: {
        mobilePhotoSourcePolicy:
          companyMobileSettings.mobilePhotoSourcePolicy || 'CAMERA_ONLY',
        saveCapturedPhotosToDeviceGallery: Boolean(
          companyMobileSettings.saveCapturedPhotosToDeviceGallery,
        ),
        stationNegativeTolerancePercent: Number(
          companyMobileSettings.stationNegativeTolerancePercent ?? 2,
        ),
      },
    };
  }


  async getMobileRecoveryContext(
    projectId: string,
    occurredAtInput: string,
    request?: RequestLike,
  ) {
    /*
      Mobile Recovery only.

      IMPORTANT:
      - This method is intentionally separate from getMobileFormContext().
      - It does not change the normal Add Operation context used by Mobile.
      - It does not change create(), resolveEntityProjectAt(), or any Web flow.
      - Its only purpose is to expose the entities that belonged to the selected
        project at the original operation occurredAt.
    */
    const currentUser = await this.resolveAuthenticatedCurrentUser(request);

    this.validateRoleCanCreateAnyOperation(currentUser);

    const selectedProjectId = String(projectId || '').trim();
    if (!selectedProjectId) {
      throw new BadRequestException(
        'projectId is required for mobile recovery context.',
      );
    }

    const occurredAtText = String(occurredAtInput || '').trim();
    if (!occurredAtText) {
      throw new BadRequestException(
        'occurredAt is required for mobile recovery context.',
      );
    }

    const occurredAt = new Date(occurredAtText);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new BadRequestException(
        'occurredAt must be a valid ISO date-time for mobile recovery context.',
      );
    }

    if (occurredAt.getTime() > Date.now()) {
      throw new BadRequestException(
        'occurredAt cannot be in the future for mobile recovery context.',
      );
    }

    if (!currentUser.companyId) {
      throw new UnauthorizedException(
        'Authenticated user company was not found.',
      );
    }

    /*
      Keep the same CURRENT access boundary as the normal mobile form context.
      The recovery endpoint must not broaden project access.
    */
    if (currentUser.role === 'Manager') {
      if (!currentUser.managedProjectIds.includes(selectedProjectId)) {
        throw new ForbiddenException(
          'Manager can create operations for managed projects only.',
        );
      }
    } else if (
      ['Operator', 'Supervisor'].includes(currentUser.role) &&
      !currentUser.assignedProjectIds.includes(selectedProjectId)
    ) {
      throw new ForbiddenException(
        'Selected project is not assigned to this user.',
      );
    }

    const project = await (this.prisma as any).project.findFirst({
      where: {
        id: selectedProjectId,
        companyId: currentUser.companyId,
        deletedAt: null,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        code: true,
      },
    });

    if (!project) {
      throw new NotFoundException(
        'Selected active project was not found.',
      );
    }

    /*
      Candidate entities are company-scoped, still active, not deleted, and
      already existed by occurredAt. We intentionally do NOT filter by their
      current projectId because Recovery needs entities that may have moved
      away from this project after the offline operation happened.
    */
    const [candidateAssets, candidateStations] = await Promise.all([
      (this.prisma as any).asset.findMany({
        where: {
          companyId: currentUser.companyId,
          deletedAt: null,
          status: 'ACTIVE',
          createdAt: { lte: occurredAt },
        },
        select: {
          id: true,
          assetId: true,
          type: true,
          category: true,
          status: true,
          projectId: true,
          currentOdometer: true,
          currentLifetimeOdometer: true,
          currentMeterCycle: true,
          fuelTankCapacity: true,
          createdAt: true,
        },
        orderBy: [{ assetId: 'asc' }],
      }),
      (this.prisma as any).station.findMany({
        where: {
          companyId: currentUser.companyId,
          deletedAt: null,
          status: 'ACTIVE',
          createdAt: { lte: occurredAt },
        },
        select: {
          id: true,
          stationId: true,
          name: true,
          status: true,
          projectId: true,
          currentStock: true,
          currentCounter: true,
          currentLifetimeCounter: true,
          currentCounterCycle: true,
          capacity: true,
          structureType: true,
          parentStationId: true,
          parentStation: {
            select: {
              id: true,
              stationId: true,
              name: true,
              status: true,
              structureType: true,
              projectId: true,
              currentStock: true,
              capacity: true,
            },
          },
          dispensers: {
            where: { deletedAt: null },
            orderBy: [{ stationId: 'asc' }],
            select: {
              id: true,
              stationId: true,
              name: true,
              status: true,
              structureType: true,
              parentStationId: true,
              currentCounter: true,
              currentLifetimeCounter: true,
              currentCounterCycle: true,
            },
          },
          createdAt: true,
        },
        orderBy: [{ stationId: 'asc' }, { name: 'asc' }],
      }),
    ]);

    const assetIds = candidateAssets.map((asset: any) => asset.id);
    const stationIds = candidateStations.map((station: any) => station.id);

    /*
      Load assignment history in two batched queries. This keeps Recovery
      efficient without touching the existing create-path resolver.
    */
    const [assetHistory, stationHistory] = await Promise.all([
      assetIds.length
        ? (this.prisma as any).assetAssignmentHistory.findMany({
            where: {
              companyId: currentUser.companyId,
              assetId: { in: assetIds },
            },
            select: {
              assetId: true,
              fromProjectId: true,
              toProjectId: true,
              assignedAt: true,
            },
            orderBy: [{ assetId: 'asc' }, { assignedAt: 'asc' }],
          })
        : Promise.resolve([]),
      stationIds.length
        ? (this.prisma as any).stationAssignmentHistory.findMany({
            where: {
              companyId: currentUser.companyId,
              stationId: { in: stationIds },
            },
            select: {
              stationId: true,
              fromProjectId: true,
              toProjectId: true,
              assignedAt: true,
            },
            orderBy: [{ stationId: 'asc' }, { assignedAt: 'asc' }],
          })
        : Promise.resolve([]),
    ]);

    const assetHistoryById = new Map<string, any[]>();
    for (const item of assetHistory) {
      const list = assetHistoryById.get(item.assetId) || [];
      list.push(item);
      assetHistoryById.set(item.assetId, list);
    }

    const stationHistoryById = new Map<string, any[]>();
    for (const item of stationHistory) {
      const list = stationHistoryById.get(item.stationId) || [];
      list.push(item);
      stationHistoryById.set(item.stationId, list);
    }

    /*
      Mirror the established resolveEntityProjectAt() semantics without
      changing that existing helper:
      1) latest assignment at/before occurredAt -> its toProjectId
      2) if all history is after occurredAt -> earliest fromProjectId
      3) no usable history -> current entity projectId
    */
    const resolveHistoricalProjectId = (
      entity: any,
      history: any[],
    ): string | null => {
      let latestBeforeOrAt: any | null = null;

      for (const item of history) {
        if (new Date(item.assignedAt).getTime() <= occurredAt.getTime()) {
          latestBeforeOrAt = item;
        } else {
          break;
        }
      }

      if (latestBeforeOrAt) {
        return latestBeforeOrAt.toProjectId || null;
      }

      const earliestHistory = history[0];
      if (
        earliestHistory &&
        new Date(earliestHistory.assignedAt).getTime() > occurredAt.getTime()
      ) {
        return earliestHistory.fromProjectId || null;
      }

      return entity.projectId || null;
    };

    const assets = candidateAssets
      .filter(
        (asset: any) =>
          resolveHistoricalProjectId(
            asset,
            assetHistoryById.get(asset.id) || [],
          ) === selectedProjectId,
      )
      .map((asset: any) => ({
        id: asset.id,
        assetId: asset.assetId,
        type: asset.type,
        category: asset.category,
        projectId: selectedProjectId,
        projectName: project.name,
        projectCode: project.code,
        currentOdometer: Number(asset.currentOdometer || 0),
        currentLifetimeOdometer: Number(
          asset.currentLifetimeOdometer || 0,
        ),
        currentMeterCycle: Number(asset.currentMeterCycle || 1),
        fuelTankCapacity:
          asset.fuelTankCapacity == null
            ? null
            : Number(asset.fuelTankCapacity),
      }));

    const stations = candidateStations
      .filter(
        (station: any) =>
          resolveHistoricalProjectId(
            station,
            stationHistoryById.get(station.id) || [],
          ) === selectedProjectId,
      )
      .map((station: any) => ({
        id: station.id,
        stationId: station.stationId,
        name: station.name,
        projectId: selectedProjectId,
        projectName: project.name,
        projectCode: project.code,
        structureType: station.structureType || 'STANDALONE',
        parentStationId: station.parentStationId || null,
        parentStation: station.parentStation || null,
        dispensers: (station.dispensers || [])
          .filter((item: any) =>
            String(item?.status || '').trim().toUpperCase() === 'ACTIVE',
          )
          .map((item: any) => ({
            ...item,
            currentCounter: Number(item.currentCounter || 0),
            currentLifetimeCounter: Number(item.currentLifetimeCounter || 0),
            currentCounterCycle: Number(item.currentCounterCycle || 1),
          })),
        currentStock: Number(station.currentStock || 0),
        currentCounter: Number(station.currentCounter || 0),
        currentLifetimeCounter: Number(
          station.currentLifetimeCounter || 0,
        ),
        currentCounterCycle: Number(station.currentCounterCycle || 1),
        capacity:
          station.capacity == null ? null : Number(station.capacity),
      }));

    return {
      project,
      occurredAt: occurredAt.toISOString(),
      stations,
      assets,
    };
  }


  async review(operationId: string, dto: ReviewOperationDto, request?: RequestLike) {
    const currentUser = await this.resolveCurrentUser(
      { type: 'DIRECT_REFUEL' as any, quantity: 1 } as CreateOperationDto,
      request,
    );

    if (!currentUser.existsInDatabase) {
      throw new UnauthorizedException('Real database user is required to review operation approvals.');
    }
    if (currentUser.role !== 'Manager') {
      throw new ForbiddenException('Only project managers can review operation approvals.');
    }

    const action = String(dto.action || '').trim().toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(action)) {
      throw new BadRequestException('Review action must be APPROVE or REJECT.');
    }

    const operation = await (this.prisma as any).operation.findFirst({
      where: { id: operationId, companyId: currentUser.companyId },
      include: { approvals: true, stationCounterReadings: true, dispenserAllocations: true },
    });
    if (!operation) throw new NotFoundException('Operation was not found.');
    if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(operation.status)) {
      throw new BadRequestException(`Operation cannot be reviewed because it is already ${operation.status}.`);
    }

    const approval = operation.approvals.find(
      (item: any) => item.approverUserId === currentUser.id && item.status === 'PENDING',
    );
    if (!approval) {
      throw new ForbiddenException('You do not have a pending approval for this operation.');
    }

    if (action === 'APPROVE') {
      this.validateRequiredPhotosByType(
        this.normalizeOperationType(operation.type),
        operation.attachments,
      );
    }

    const operationDto = {
      type: operation.type,
      sourceStationId: operation.sourceStationId || undefined,
      destinationStationId: operation.destinationStationId || undefined,
      assetId: operation.assetId || undefined,
      quantity: Number(operation.quantity),
      odometer: operation.odometer == null ? undefined : Number(operation.odometer),
      stationCounter: operation.stationCounter == null ? undefined : Number(operation.stationCounter),
      dispenserReadings: Array.isArray(operation.stationCounterReadings)
        ? operation.stationCounterReadings.map((item: any) => ({
            stationId: item.stationId,
            counter: Number(item.counterValue),
          }))
        : undefined,
      dispenserAllocations: Array.isArray(operation.dispenserAllocations)
        ? operation.dispenserAllocations.map((item: any) => ({
            stationId: item.stationId,
            quantity: Number(item.quantity),
          }))
        : undefined,
      externalStationName: operation.externalStationName || undefined,
      invoiceNumber: operation.invoiceNumber || undefined,
      notes: operation.notes || undefined,
      companyId: operation.companyId,
    } as CreateOperationDto;

    const entities = action === 'APPROVE'
      ? await this.loadAndValidateEntities(
          this.prisma as any,
          operationDto,
          currentUser,
          operation.type,
          new Date(operation.occurredAt),
          {
            /*
              Review authorization is already enforced by the PENDING
              OperationApproval row for the current manager. Do not re-run the
              operation-creation project-access rule here, because an external
              transfer destination manager may legitimately approve an operation
              whose source project they do not manage.
            */
            skipUserProjectAccess: true,
          },
        )
      : undefined;

    const useHistoricalAssetMeterPath =
      action === 'APPROVE' && entities
        ? await this.shouldUseHistoricalAssetMeterPath(
            this.prisma as any,
            operation.type,
            entities.asset?.id,
            operation.occurredAt,
          )
        : false;

    const meterSnapshot =
      action === 'APPROVE' && entities
        ? useHistoricalAssetMeterPath
          ? this.emptyOperationMeterSnapshot()
          : this.buildOperationMeterSnapshot(
              operation.type,
              operationDto,
              entities,
            )
        : this.emptyOperationMeterSnapshot();

    const result = await this.prisma.$transaction(async (tx) => {
      const claimed = await (tx as any).operationApproval.updateMany({
        where: { id: approval.id, approverUserId: currentUser.id, status: 'PENDING' },
        data: {
          status: action === 'REJECT' ? 'REJECTED' : 'APPROVED',
          note: dto.note || null,
          reviewedAt: new Date(),
        },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('This approval was already reviewed by another request.');
      }

      if (action === 'REJECT') {
        const rejectedAt = new Date();

        const rejected = await (tx as any).operation.updateMany({
          where: {
            id: operation.id,
            status: { in: ['PENDING', 'PARTIALLY_APPROVED'] },
          },
          data: {
            status: 'REJECTED',
            rejectedAt,
          },
        });

        if (rejected.count !== 1) {
          throw new BadRequestException(
            'Operation status changed before this review was completed.',
          );
        }

        /*
          One rejection closes the whole operation. Any other manager approvals
          that are still PENDING must be closed as well; otherwise the rejected
          operation remains visible in another manager's approval queue and can
          never be reviewed because the operation itself is already terminal.
        */
        await (tx as any).operationApproval.updateMany({
          where: {
            operationId: operation.id,
            status: 'PENDING',
          },
          data: {
            status: 'REJECTED',
            reviewedAt: rejectedAt,
            note: 'Closed automatically because the operation was rejected by another approver.',
          },
        });

        return {
          status: 'REJECTED',
          completedNow: false,
          rejectedNow: true,
        };
      }

      const pendingCount = await (tx as any).operationApproval.count({
        where: { operationId: operation.id, status: 'PENDING' },
      });

      if (pendingCount > 0) {
        await (tx as any).operation.updateMany({
          where: { id: operation.id, status: { in: ['PENDING', 'PARTIALLY_APPROVED'] } },
          data: { status: 'PARTIALLY_APPROVED', approvedAt: new Date() },
        });
        return { status: 'PARTIALLY_APPROVED', completedNow: false, rejectedNow: false };
      }

      const completed = await (tx as any).operation.updateMany({
        where: {
          id: operation.id,
          status: { in: ['PENDING', 'PARTIALLY_APPROVED'] },
        },
        data: {
          status: 'COMPLETED',
          approvedAt: new Date(),
          completedAt: new Date(),
          lifetimeOdometer: meterSnapshot.lifetimeOdometer,
          assetMeterCycleNumber: meterSnapshot.assetMeterCycleNumber,
          lifetimeCounter: meterSnapshot.lifetimeCounter,
          stationCounterCycleNumber:
            meterSnapshot.stationCounterCycleNumber,
        },
      });
      if (completed.count !== 1) {
        throw new BadRequestException(
          'Operation was already completed by another approval request.',
        );
      }

      const completedOperation = {
        ...operation,
        status: 'COMPLETED',
        ...meterSnapshot,
      };

      await this.applyCompletedOperationEffects(tx, {
        operation: completedOperation,
        dto: operationDto,
        type: operation.type,
        currentUser,
        entities: entities!,
        useHistoricalAssetMeterPath,
      });
      return { status: 'COMPLETED', completedNow: true, rejectedNow: false };
    }, { maxWait: 10000, timeout: 15000 });

    // Keep the persistent approval notification in sync with the decision.
    // This is best-effort and must never affect the already-committed review.
    await Promise.allSettled([
      this.notificationsService.closeOperationApprovalRequired({
        operationId: operation.id,
        userId: currentUser.id,
        status: result.rejectedNow ? 'REJECTED' : 'APPROVED',
      }),
    ]);

    this.operationsRealtime.publish({
      type: 'operation.updated',
      companyId: currentUser.companyId!,
      actorUserId: currentUser.id,
      operationId: operation.id,
      operationNo: operation.operationNo,
      operationType: operation.type,
      status: result.status,
      projectIds: Array.from(
        new Set(
          [
            operation.projectIdAtOperation,
            operation.sourceProjectIdAtOperation,
            operation.destinationProjectIdAtOperation,
          ].filter(Boolean),
        ),
      ) as string[],
      occurredAt: new Date().toISOString(),
    });

    if (result.completedNow || result.rejectedNow) {
      await this.sendFinalOperationApprovalResultNotificationsBestEffort({
        operation,
        status: result.rejectedNow ? 'REJECTED' : 'COMPLETED',
      });
    }

    return {
      ok: true,
      operationId: operation.id,
      operationNo: operation.operationNo,
      status: result.status,
      completedNow: result.completedNow,
      rejectedNow: result.rejectedNow,
      reviewedBy: { id: currentUser.id, name: currentUser.fullName, role: currentUser.role },
      message: result.rejectedNow
        ? 'Operation rejected successfully.'
        : result.completedNow
          ? 'Operation approved and completed successfully.'
          : 'Operation approved and pending remaining project manager approval.',
    };
  }

async getMobileDashboard(
  request?: RequestLike,
  options?: {
    projectId?: string;
    utcOffsetMinutes?: string | number;
  },
) {
  /*
    Mobile executive dashboard.

    Scope:
    - Admin / TopManagement: company-wide.
    - Manager: managed projects only; optional projectId may narrow to one managed project.
    - Supervisor / Operator / Officer are intentionally not allowed.

    Consumption:
    - COMPLETED DIRECT_REFUEL + EXTERNAL_DIRECT_REFUEL only.
    - Quantity comes from the historical operation quantity.
    - Cost comes from totalCostAtOperation, preserving the historical cost snapshot.

    Time windows:
    - KPIs + table: current local day and last 7 local calendar days.
    - Trend + asset-type distribution: last 3 local calendar months through now.
    - utcOffsetMinutes is supplied by the mobile device only to define local
      calendar-day boundaries; it never affects authorization or project scope.
  */
  const currentUser = await this.resolveAuthenticatedCurrentUser(request);

  if (!currentUser.companyId) {
    throw new UnauthorizedException(
      'Authenticated user company was not found.',
    );
  }

  if (!['Admin', 'TopManagement', 'Manager'].includes(currentUser.role)) {
    throw new ForbiddenException(
      'Mobile dashboard is available to Admin, Top Management, and Manager only.',
    );
  }

  const requestedProjectId = String(options?.projectId || '').trim();

  let scopedProjectIds: string[] | null = null;
  let scopeMode: 'COMPANY' | 'MANAGED_PROJECTS' | 'PROJECT' = 'COMPANY';

  if (currentUser.role === 'Manager') {
    const managedProjectIds = Array.from(
      new Set((currentUser.managedProjectIds || []).filter(Boolean)),
    );

    if (requestedProjectId) {
      if (!managedProjectIds.includes(requestedProjectId)) {
        throw new ForbiddenException(
          'Manager cannot view dashboard data for this project.',
        );
      }

      scopedProjectIds = [requestedProjectId];
      scopeMode = 'PROJECT';
    } else {
      scopedProjectIds = managedProjectIds;
      scopeMode = 'MANAGED_PROJECTS';
    }
  }

  const rawOffset = Number(options?.utcOffsetMinutes ?? 0);
  const utcOffsetMinutes =
    Number.isFinite(rawOffset) && rawOffset >= -840 && rawOffset <= 840
      ? Math.trunc(rawOffset)
      : 0;
  const offsetMs = utcOffsetMinutes * 60 * 1000;

  const now = new Date();

  const shiftedNow = new Date(now.getTime() + offsetMs);
  const shiftedTodayStart = new Date(shiftedNow);
  shiftedTodayStart.setUTCHours(0, 0, 0, 0);

  const todayStart = new Date(shiftedTodayStart.getTime() - offsetMs);
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  const last7Start = new Date(
    todayStart.getTime() - 6 * 24 * 60 * 60 * 1000,
  );

  const shiftedTrendStart = new Date(shiftedTodayStart);
  shiftedTrendStart.setUTCMonth(shiftedTrendStart.getUTCMonth() - 3);
  const trendStart = new Date(shiftedTrendStart.getTime() - offsetMs);

  const [operations, stockStationsRaw] = await Promise.all([
    (this.prisma as any).operation.findMany({
      where: {
        companyId: currentUser.companyId,
        status: 'COMPLETED',
        type: {
          in: ['DIRECT_REFUEL', 'EXTERNAL_DIRECT_REFUEL'],
        },
        occurredAt: {
          gte: trendStart,
          lte: now,
        },
        ...(scopedProjectIds
          ? scopedProjectIds.length
            ? {
                projectIdAtOperation: {
                  in: scopedProjectIds,
                },
              }
            : {
                // A Manager with no managed projects must see no company data.
                id: '__NO_RESULTS__',
              }
          : {}),
      },
      select: {
        quantity: true,
        totalCostAtOperation: true,
        occurredAt: true,
        asset: {
          select: {
            type: true,
          },
        },
      },
      orderBy: {
        occurredAt: 'asc',
      },
    }),
    scopedProjectIds && scopedProjectIds.length === 0
      ? Promise.resolve([])
      : (this.prisma as any).station.findMany({
          where: {
            companyId: currentUser.companyId,
            deletedAt: null,
            status: 'ACTIVE',
            ...(scopedProjectIds
              ? {
                  projectId: {
                    in: scopedProjectIds,
                  },
                }
              : {}),
          },
          select: {
            id: true,
            stationId: true,
            name: true,
            projectId: true,
            structureType: true,
            currentStock: true,
            project: {
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
          },
          orderBy: [{ stationId: 'asc' }, { name: 'asc' }],
        }),
  ]);

  const stockStations = stockStationsRaw
    .filter(
      (station: any) =>
        String(station.structureType || 'STANDALONE').toUpperCase() !==
        'DISPENSER',
    )
    .map((station: any) => ({
      id: station.id,
      stationId: station.stationId,
      name: station.name,
      projectId: station.projectId,
      projectName:
        station.project?.name ||
        station.project?.code ||
        station.projectId ||
        '',
      structureType: station.structureType || 'STANDALONE',
      currentStock: Number(station.currentStock || 0),
    }));

  const currentStockTotal = stockStations.reduce(
    (sum: number, station: any) => sum + Number(station.currentStock || 0),
    0,
  );

  const toLocalDateKey = (value: Date | string) => {
    const date = value instanceof Date ? value : new Date(value);
    return new Date(date.getTime() + offsetMs).toISOString().slice(0, 10);
  };

  const sumRows = (rows: any[]) => ({
    quantity: rows.reduce(
      (sum: number, row: any) => sum + Number(row.quantity || 0),
      0,
    ),
    cost: rows.reduce(
      (sum: number, row: any) =>
        sum + Number(row.totalCostAtOperation || 0),
      0,
    ),
  });

  const todayRows = operations.filter((operation: any) => {
    const occurredAt = new Date(operation.occurredAt);
    return occurredAt >= todayStart && occurredAt < tomorrowStart;
  });

  const last7Rows = operations.filter(
    (operation: any) => new Date(operation.occurredAt) >= last7Start,
  );

  const todayTotals = sumRows(todayRows);
  const last7Totals = sumRows(last7Rows);

  const daily7Map = new Map<
    string,
    { date: string; quantity: number; cost: number }
  >();

  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const dayStart = new Date(
      last7Start.getTime() + dayIndex * 24 * 60 * 60 * 1000,
    );
    const dateKey = toLocalDateKey(dayStart);
    daily7Map.set(dateKey, {
      date: dateKey,
      quantity: 0,
      cost: 0,
    });
  }

  for (const operation of last7Rows) {
    const dateKey = toLocalDateKey(operation.occurredAt);
    const bucket = daily7Map.get(dateKey);
    if (!bucket) continue;

    bucket.quantity += Number(operation.quantity || 0);
    bucket.cost += Number(operation.totalCostAtOperation || 0);
  }

  const dailyConsumption = Array.from(daily7Map.values())
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((row) => ({
      date: row.date,
      quantity: Number(row.quantity.toFixed(2)),
      cost: Number(row.cost.toFixed(2)),
    }));

  const trendMap = new Map<
    string,
    { date: string; quantity: number }
  >();

  const trendDays = Math.floor(
    (todayStart.getTime() - trendStart.getTime()) /
      (24 * 60 * 60 * 1000),
  );

  for (let dayIndex = 0; dayIndex <= trendDays; dayIndex += 1) {
    const dayStart = new Date(
      trendStart.getTime() + dayIndex * 24 * 60 * 60 * 1000,
    );
    const dateKey = toLocalDateKey(dayStart);
    trendMap.set(dateKey, {
      date: dateKey,
      quantity: 0,
    });
  }

  for (const operation of operations) {
    const dateKey = toLocalDateKey(operation.occurredAt);
    const bucket = trendMap.get(dateKey);
    if (!bucket) continue;

    bucket.quantity += Number(operation.quantity || 0);
  }

  const consumptionTrend = Array.from(trendMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((row) => ({
      date: row.date,
      quantity: Number(row.quantity.toFixed(2)),
    }));

  const assetTypeMap = new Map<string, number>();

  for (const operation of operations) {
    const assetType = String(operation.asset?.type || '').trim() || 'Unknown';
    assetTypeMap.set(
      assetType,
      (assetTypeMap.get(assetType) || 0) + Number(operation.quantity || 0),
    );
  }

  const assetTypeDistribution = Array.from(assetTypeMap.entries())
    .map(([assetType, quantity]) => ({
      assetType,
      quantity: Number(quantity.toFixed(2)),
    }))
    .sort((a, b) => b.quantity - a.quantity);

  return {
    generatedAt: now.toISOString(),
    utcOffsetMinutes,
    scope: {
      role: currentUser.role,
      mode: scopeMode,
      projectId:
        scopeMode === 'PROJECT' ? scopedProjectIds?.[0] || null : null,
      projectCount:
        scopedProjectIds == null ? null : scopedProjectIds.length,
    },
    windows: {
      todayFrom: todayStart.toISOString(),
      todayTo: tomorrowStart.toISOString(),
      last7DaysFrom: last7Start.toISOString(),
      trendFrom: trendStart.toISOString(),
      trendTo: now.toISOString(),
    },
    kpis: {
      todayQuantity: Number(todayTotals.quantity.toFixed(2)),
      todayCost: Number(todayTotals.cost.toFixed(2)),
      last7DaysQuantity: Number(last7Totals.quantity.toFixed(2)),
      last7DaysCost: Number(last7Totals.cost.toFixed(2)),
      dailyAverageQuantity: Number((last7Totals.quantity / 7).toFixed(2)),
      dailyAverageCost: Number((last7Totals.cost / 7).toFixed(2)),
      currentStockTotal: Number(currentStockTotal.toFixed(2)),
    },
    stockStations,
    dailyConsumption,
    consumptionTrend,
    assetTypeDistribution,
  };
}

async getMobileMyOperations(request?: RequestLike) {
  /*
    Mobile "My Operations" history.

    Security / scope rules:
    - The authenticated user identity always comes from the JWT request.
    - The client cannot choose another userId, employeeId, companyId, projectId,
      or date range.
    - Only operations created by the authenticated user are returned.
    - The window is a rolling 24 hours based on the operation occurredAt value,
      not the later server sync/create time.
    - Return only the compact fields required by the Mobile review screen.
  */
  const currentUser = await this.resolveAuthenticatedCurrentUser(request);

  if (!currentUser.companyId) {
    throw new UnauthorizedException(
      'Authenticated user company was not found.',
    );
  }

  const windowTo = new Date();
  const windowFrom = new Date(windowTo.getTime() - 24 * 60 * 60 * 1000);

  const operations = await (this.prisma as any).operation.findMany({
    where: {
      companyId: currentUser.companyId,
      requestedByUserId: currentUser.id,
      occurredAt: {
        gte: windowFrom,
        lte: windowTo,
      },
    },

    select: {
      operationNo: true,
      type: true,
      status: true,
      quantity: true,
      occurredAt: true,
      odometer: true,
      stationCounter: true,
      asset: {
        select: {
          assetId: true,
        },
      },
      destinationStation: {
        select: {
          stationId: true,
        },
      },
    },

    orderBy: [
      { occurredAt: 'desc' },
      { createdAt: 'desc' },
    ],
  });

  const compactOperations = operations.map((operation: any) => {
    const isAssetOperation = [
      'DIRECT_REFUEL',
      'EXTERNAL_DIRECT_REFUEL',
    ].includes(String(operation.type || '').toUpperCase());

    return {
      operationNo: operation.operationNo,
      type: operation.type,
      status: operation.status,
      quantity: Number(operation.quantity),
      occurredAt: operation.occurredAt,
      targetIdentifier: isAssetOperation
        ? operation.asset?.assetId || null
        : operation.destinationStation?.stationId || null,
      destinationMeter: isAssetOperation
        ? operation.odometer == null
          ? null
          : Number(operation.odometer)
        : operation.stationCounter == null
          ? null
          : Number(operation.stationCounter),
    };
  });

  return {
    windowHours: 24,
    windowFrom: windowFrom.toISOString(),
    windowTo: windowTo.toISOString(),
    count: compactOperations.length,
    operations: compactOperations,
  };
}

async findAll(request?: RequestLike) {
  const startedAt = Date.now();

  const currentUser = await this.resolveCurrentUser(
    {
      type: 'DIRECT_REFUEL' as any,
      quantity: 1,
    } as CreateOperationDto,
    request,
  );

  const resolveUserMs = Date.now() - startedAt;

  if (!currentUser.existsInDatabase) {
    throw new UnauthorizedException(
      'Real database user is required.',
    );
  }

  const queryStartedAt = Date.now();

  const operations = await (this.prisma as any).operation.findMany({
    where: {
      companyId: currentUser.companyId,
    },

    include: this.buildOperationListInclude(),

    orderBy: {
      occurredAt: 'desc',
    },

    // Temporary safety cap until cursor pagination is added to the frontend.
    take: 100,
  });

  console.log(
    '[PERF][operations.findAll]',
    JSON.stringify({
      totalMs: Date.now() - startedAt,
      resolveUserMs,
      queryMs: Date.now() - queryStartedAt,
      companyId: currentUser.companyId,
      resultCount: operations.length,
      limit: 100,
    }),
  );

  return operations;
}

async findPendingApprovals(request?: RequestLike) {
  const startedAt = Date.now();

  const currentUser = await this.resolveCurrentUser(
    {
      type: 'DIRECT_REFUEL' as any,
      quantity: 1,
    } as CreateOperationDto,
    request,
  );

  const resolveUserMs = Date.now() - startedAt;

  if (!currentUser.existsInDatabase) {
    throw new UnauthorizedException(
      'Real database user is required.',
    );
  }

  const queryStartedAt = Date.now();

  const operations = await (this.prisma as any).operation.findMany({
    where: {
      companyId: currentUser.companyId,

      // Defensive filter for legacy/stale approval rows. A terminal operation
      // must never remain visible in the active approvals queue even if an old
      // approval row was left PENDING before this fix.
      status: {
        in: ['PENDING', 'PARTIALLY_APPROVED'],
      },

      approvals: {
        some: {
          approverUserId: currentUser.id,
          status: 'PENDING',
        },
      },
    },

    include: this.buildOperationListInclude(),

    orderBy: {
      occurredAt: 'desc',
    },

    take: 100,
  });

  console.log(
    '[PERF][operations.findPendingApprovals]',
    JSON.stringify({
      totalMs: Date.now() - startedAt,
      resolveUserMs,
      queryMs: Date.now() - queryStartedAt,
      companyId: currentUser.companyId,
      userId: currentUser.id,
      resultCount: operations.length,
      limit: 100,
    }),
  );

  return operations;
}

async getSummaryReport(request: RequestLike | undefined, filters: {
  projectId?: string;
  assetId?: string;
  type?: string;
  status?: string;
  fuelerEmployeeId?: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  const currentUser = await this.resolveCurrentUser(
    { type: 'DIRECT_REFUEL' as any, quantity: 1 } as CreateOperationDto,
    request,
  );

  if (!currentUser.existsInDatabase || !currentUser.companyId) {
    throw new UnauthorizedException('Real database user is required.');
  }

  const occurredAt: Record<string, Date> = {};
  if (filters.dateFrom) {
    const from = new Date(filters.dateFrom);
    if (Number.isNaN(from.getTime())) {
      throw new BadRequestException('dateFrom is invalid');
    }
    occurredAt.gte = from;
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    if (Number.isNaN(to.getTime())) {
      throw new BadRequestException('dateTo is invalid');
    }
    to.setHours(23, 59, 59, 999);
    occurredAt.lte = to;
  }

  const accessibleProjectIds =
    currentUser.role === 'Manager'
      ? currentUser.managedProjectIds
      : ['Officer', 'Operator', 'Supervisor'].includes(currentUser.role)
        ? currentUser.assignedProjectIds
        : [];
  const scopedProjectIds = filters.projectId
    ? [filters.projectId]
    : accessibleProjectIds;
  const needsProjectScope = ['Manager', 'Officer', 'Operator', 'Supervisor'].includes(
    currentUser.role,
  );

  if (
    filters.projectId &&
    needsProjectScope &&
    !accessibleProjectIds.includes(filters.projectId)
  ) {
    throw new ForbiddenException('You cannot view this project report.');
  }

  const fuelerCode = String(filters.fuelerEmployeeId || '').trim();
  const operations = await (this.prisma as any).operation.findMany({
    where: {
      companyId: currentUser.companyId,
      ...(filters.assetId ? { assetId: filters.assetId } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(Object.keys(occurredAt).length ? { occurredAt } : {}),
      ...(scopedProjectIds.length
        ? {
            OR: [
              { projectIdAtOperation: { in: scopedProjectIds } },
              { sourceProjectIdAtOperation: { in: scopedProjectIds } },
              { destinationProjectIdAtOperation: { in: scopedProjectIds } },
            ],
          }
        : {}),
      ...(fuelerCode
        ? {
            AND: [
              {
                OR: [
                  { fuelerEmployeeIdAtOperation: fuelerCode },
                  {
                    fuelerEmployeeIdAtOperation: null,
                    requestedBy: {
                      is: {
                        OR: [
                          { employeeId: fuelerCode },
                          { linkedEmployee: { is: { employeeId: fuelerCode } } },
                        ],
                      },
                    },
                  },
                ],
              },
            ],
          }
        : {}),
    },
    include: this.buildOperationListInclude(),
    orderBy: { occurredAt: 'desc' },
    take: 5000,
  });

  const rows = operations.map((operation: any) => ({
    ...operation,
    fuelerEmployeeId:
      operation.fuelerEmployeeIdAtOperation ||
      operation.requestedBy?.linkedEmployee?.employeeId ||
      operation.requestedBy?.employeeId ||
      null,
    fuelerName:
      operation.fuelerNameAtOperation ||
      operation.requestedBy?.linkedEmployee?.name ||
      operation.requestedBy?.fullName ||
      null,
  }));

  return {
    summary: {
      records: rows.length,
      totalQuantity: rows.reduce(
        (sum: number, row: any) => sum + Number(row.quantity || 0),
        0,
      ),
      totalCost: rows.reduce(
        (sum: number, row: any) =>
          sum + Number(row.totalCostAtOperation || 0),
        0,
      ),
    },
    rows,
  };
}

  private async sendPendingOperationApprovalNotificationsBestEffort(params: {
    operation: any;
    type: NormalizedOperationType;
    currentUser: CurrentUserContext;
    approvalPlan: ApprovalPlanItem[];
  }) {
    const pendingApprovals = params.approvalPlan.filter(
      (item) => item.status === 'PENDING',
    );

    if (pendingApprovals.length === 0) return;

    /*
      Push delivery is intentionally outside the operation transaction and
      best-effort only. A notification outage must never fail or roll back a
      successfully-created fuel operation.
    */
    await Promise.allSettled(
      pendingApprovals.map((approval) =>
        this.notificationsService.sendOperationApprovalRequired({
          approverUserId: approval.approverUserId,
          operationId: params.operation.id,
          operationNo: params.operation.operationNo,
          operationType: params.type,
          approvalStage: approval.approvalStage,
          requestedByName: params.currentUser.fullName,
        }),
      ),
    );
  }

  private async sendFinalOperationApprovalResultNotificationsBestEffort(params: {
    operation: any;
    status: 'COMPLETED' | 'REJECTED';
  }) {
    const recipientUserIds = Array.from(
      new Set(
        [
          ...(params.operation.approvals || []).map((approval: any) =>
            String(approval.approverUserId || '').trim(),
          ),
          String(params.operation.requestedByUserId || '').trim(),
        ].filter(Boolean),
      ),
    ) as string[];

    if (recipientUserIds.length === 0) return;

    /*
      Final approval-result notifications are informational and must never affect
      the review transaction. Every approver plus the original requester receives
      the terminal result for any operation that went through the approval flow.
      This intentionally covers EXTERNAL_DIRECT_REFUEL, EXTERNAL_SUPPLY, and
      EXTERNAL_TRANSFER. Set-based deduplication prevents duplicates when the
      requester is also one of the approvers.
    */
    await Promise.allSettled(
      recipientUserIds.map((recipientUserId) =>
        this.notificationsService.sendOperationApprovalResult({
          recipientUserId,
          operationId: params.operation.id,
          operationNo: params.operation.operationNo,
          operationType: params.operation.type,
          status: params.status,
        }),
      ),
    );
  }

  private buildOperationLocationSnapshot(
    dto: CreateOperationDto,
  ): OperationLocationSnapshot {
    const hasLatitude = dto.locationLatitude !== undefined && dto.locationLatitude !== null;
    const hasLongitude = dto.locationLongitude !== undefined && dto.locationLongitude !== null;
    const hasAccuracy = dto.locationAccuracy !== undefined && dto.locationAccuracy !== null;
    const hasCapturedAt =
      dto.locationCapturedAt !== undefined &&
      dto.locationCapturedAt !== null &&
      String(dto.locationCapturedAt).trim() !== '';

    const hasAnyLocationValue =
      hasLatitude || hasLongitude || hasAccuracy || hasCapturedAt;

    if (!hasAnyLocationValue) {
      return {
        locationLatitude: null,
        locationLongitude: null,
        locationAccuracy: null,
        locationCapturedAt: null,
      };
    }

    if (!hasLatitude || !hasLongitude) {
      throw new BadRequestException(
        'Location snapshot requires both latitude and longitude.',
      );
    }

    const latitude = Number(dto.locationLatitude);
    const longitude = Number(dto.locationLongitude);

    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new BadRequestException(
        'locationLatitude must be between -90 and 90.',
      );
    }

    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new BadRequestException(
        'locationLongitude must be between -180 and 180.',
      );
    }

    let accuracy: number | null = null;
    if (hasAccuracy) {
      accuracy = Number(dto.locationAccuracy);
      if (!Number.isFinite(accuracy) || accuracy < 0) {
        throw new BadRequestException(
          'locationAccuracy must be a valid non-negative number.',
        );
      }
    }

    if (!hasCapturedAt) {
      throw new BadRequestException(
        'locationCapturedAt is required when operation coordinates are supplied.',
      );
    }

    const capturedAt = new Date(String(dto.locationCapturedAt));
    if (Number.isNaN(capturedAt.getTime())) {
      throw new BadRequestException(
        'locationCapturedAt must be a valid ISO date-time.',
      );
    }

    // Small clock-skew allowance only. A snapshot timestamp far in the future
    // cannot represent the actual field location of this operation.
    if (capturedAt.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new BadRequestException(
        'locationCapturedAt cannot be in the future.',
      );
    }

    return {
      locationLatitude: latitude,
      locationLongitude: longitude,
      locationAccuracy: accuracy,
      locationCapturedAt: capturedAt,
    };
  }

  private async createPersistedOperation(
    dto: CreateOperationDto,
    currentUser: CurrentUserContext,
    type: NormalizedOperationType,
  ) {
    const serverOperationDate = new Date();
    const occurredAt = dto.occurredAt
      ? new Date(dto.occurredAt)
      : serverOperationDate;

    if (Number.isNaN(occurredAt.getTime())) {
      throw new BadRequestException('occurredAt must be a valid ISO date-time.');
    }

    const locationSnapshot = this.buildOperationLocationSnapshot(dto);

    const entities = await this.loadAndValidateEntities(
      this.prisma as any,
      dto,
      currentUser,
      type,
      occurredAt,
    );

    const pendingPhotoDrafts = await this.loadAndValidatePendingPhotoDrafts(
      dto.attachments,
      currentUser,
      type,
    );

    const securedAttachments = this.buildConsumedOperationAttachments(
      dto.attachments,
      pendingPhotoDrafts,
    );

    const approvalPlan = await this.buildApprovalPlan(
      this.prisma as any,
      currentUser,
      type,
      entities,
    );

    const status = this.getInitialOperationStatus(type, currentUser, approvalPlan);
    const completedAt = status === 'COMPLETED' ? serverOperationDate : null;

    const costSnapshot = await this.resolveOperationCostSnapshot(
      this.prisma as any,
      {
        type,
        entities,
        quantity: Number(dto.quantity),
        operationDate: occurredAt,
        externalInvoiceAmount: dto.externalInvoiceAmount,
      },
    );

    const projectSnapshot = this.buildOperationProjectSnapshot(
      type,
      entities,
    );

    /*
      Preserve the established current-state meter path for normal operations.
      Historical handling is enabled only when this completed asset-meter
      operation belongs before an already-existing completed asset meter event
      or odometer reset on the real-world timeline.
    */
    const useHistoricalAssetMeterPath =
      status === 'COMPLETED'
        ? await this.shouldUseHistoricalAssetMeterPath(
            this.prisma as any,
            type,
            entities.asset?.id,
            occurredAt,
          )
        : false;

    // Normal operations keep the exact existing snapshot logic. Historical
    // asset snapshots are rebuilt inside the write transaction after creation.
    const meterSnapshot =
      status === 'COMPLETED'
        ? useHistoricalAssetMeterPath
          ? this.emptyOperationMeterSnapshot()
          : this.buildOperationMeterSnapshot(type, dto, entities)
        : this.emptyOperationMeterSnapshot();

    let result: any;
    let lastError: any;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const operationNo = await this.generateOperationNo(
        this.prisma as any,
        currentUser.companyId!,
      );

      try {
        result = await this.prisma.$transaction(async (tx) => {
          const operation = await (tx as any).operation.create({
            data: {
              companyId: currentUser.companyId,
              operationNo,
              clientOperationId: String(dto.clientOperationId || '').trim() || null,
              type,
              status,
              sourceStationId: dto.sourceStationId || null,
              destinationStationId: dto.destinationStationId || null,
              assetId: dto.assetId || null,
              quantity: Number(dto.quantity),
              odometer: dto.odometer == null ? null : Number(dto.odometer),
              lifetimeOdometer: meterSnapshot.lifetimeOdometer,
              assetMeterCycleNumber: meterSnapshot.assetMeterCycleNumber,
              stationCounter: dto.stationCounter == null ? null : Number(dto.stationCounter),
              lifetimeCounter: meterSnapshot.lifetimeCounter,
              stationCounterCycleNumber:
                meterSnapshot.stationCounterCycleNumber,
              externalStationName: dto.externalStationName || null,
              invoiceNumber: dto.invoiceNumber || null,
              notes: dto.notes || null,
              attachments: securedAttachments,
              fuelPriceHistoryId: costSnapshot.fuelPriceHistoryId,
              pricePerLiterAtOperation: costSnapshot.pricePerLiterAtOperation,
              totalCostAtOperation: costSnapshot.totalCostAtOperation,
              basePricePerLiterAtOperation:
                costSnapshot.basePricePerLiterAtOperation,
              transportCostPerLiterAtOperation:
                costSnapshot.transportCostPerLiterAtOperation,
              vatRateAtOperation: costSnapshot.vatRateAtOperation,
              vatAmountPerLiterAtOperation:
                costSnapshot.vatAmountPerLiterAtOperation,
              grossPricePerLiterAtOperation:
                costSnapshot.grossPricePerLiterAtOperation,
              grossTotalCostAtOperation:
                costSnapshot.grossTotalCostAtOperation,
              projectIdAtOperation:
                projectSnapshot.projectIdAtOperation,
              projectNameAtOperation:
                projectSnapshot.projectNameAtOperation,
              sourceProjectIdAtOperation:
                projectSnapshot.sourceProjectIdAtOperation,
              sourceProjectNameAtOperation:
                projectSnapshot.sourceProjectNameAtOperation,
              destinationProjectIdAtOperation:
                projectSnapshot.destinationProjectIdAtOperation,
              destinationProjectNameAtOperation:
                projectSnapshot.destinationProjectNameAtOperation,
              requestedByUserId: currentUser.id,
              fuelerEmployeeIdAtOperation: currentUser.fuelerEmployeeId,
              fuelerNameAtOperation: currentUser.fuelerName,
              occurredAt,
              locationLatitude: locationSnapshot.locationLatitude,
              locationLongitude: locationSnapshot.locationLongitude,
              locationAccuracy: locationSnapshot.locationAccuracy,
              locationCapturedAt: locationSnapshot.locationCapturedAt,
              completedAt,
              approvedAt:
                status === 'COMPLETED' || status === 'PARTIALLY_APPROVED'
                  ? serverOperationDate
                  : null,
            },
          });

          await this.consumeOperationPhotoDrafts(
            tx,
            pendingPhotoDrafts,
            currentUser,
            operation.id,
          );


          if (
            dto.stationCounter !== undefined &&
            dto.stationCounter !== null &&
            entities.destinationStation &&
            this.getStationStructureType(entities.destinationStation) === 'STANDALONE' &&
            ['INTERNAL_TRANSFER', 'EXTERNAL_SUPPLY', 'EXTERNAL_TRANSFER'].includes(type)
          ) {
            await (tx as any).operationStationCounterReading.createMany({
              data: [
                {
                  operationId: operation.id,
                  companyId: currentUser.companyId!,
                  stationId: entities.destinationStation.id,
                  counterValue: Number(dto.stationCounter),
                },
              ],
              skipDuplicates: true,
            });
          }

          if (Array.isArray(dto.dispenserReadings) && dto.dispenserReadings.length) {
            await (tx as any).operationStationCounterReading.createMany({
              data: dto.dispenserReadings.map((item) => ({
                operationId: operation.id,
                companyId: currentUser.companyId!,
                stationId: String(item.stationId),
                counterValue: Number(item.counter),
              })),
              skipDuplicates: true,
            });
          }

          if (
            Array.isArray(dto.dispenserAllocations) &&
            dto.dispenserAllocations.length
          ) {
            await (tx as any).operationDispenserAllocation.createMany({
              data: dto.dispenserAllocations.map((item) => ({
                operationId: operation.id,
                companyId: currentUser.companyId!,
                stationId: String(item.stationId),
                quantity: Number(item.quantity),
              })),
              skipDuplicates: true,
            });
          }

          if (approvalPlan.length) {
            await (tx as any).operationApproval.createMany({
              data: approvalPlan.map((item) => ({
                operationId: operation.id,
                approverUserId: item.approverUserId,
                projectId: item.projectId,
                approvalStage: item.approvalStage,
                status: item.status,
                reviewedAt: item.reviewedAt || null,
              })),
              skipDuplicates: true,
            });
          }

          if (status === 'COMPLETED') {
            await this.applyCompletedOperationEffects(tx, {
              operation,
              dto,
              type,
              currentUser,
              entities,
              useHistoricalAssetMeterPath,
            });
          }

          return { operation, status, approvalPlan };
        }, { maxWait: 10000, timeout: 15000 });
        break;
      } catch (error: any) {
        lastError = error;

        /*
          Two identical requests can pass the early lookup at the same time.
          The database unique constraint is the final authority: the loser
          fetches and returns the operation created by the winning request.
        */
        if (
          dto.clientOperationId &&
          this.isClientOperationIdConflict(error)
        ) {
          const existingOperation = await this.findExistingIdempotentOperation(
            dto,
            currentUser,
            type,
          );

          if (existingOperation) {
            result = {
              operation: existingOperation,
              status: existingOperation.status,
              approvalPlan: existingOperation.approvals || [],
              idempotentReplay: true,
            };
            break;
          }
        }

        if (!this.isOperationNoConflict(error) || attempt === 3) throw error;
      }
    }

    if (!result) throw lastError;

    if (!result.idempotentReplay) {
      this.operationsRealtime.publish({
      type: 'operation.created',
      companyId: currentUser.companyId!,
      actorUserId: currentUser.id,
      operationId: result.operation.id,
      operationNo: result.operation.operationNo,
      operationType: type,
      status: result.status,
      projectIds: Array.from(
        new Set(
          [
            result.operation.projectIdAtOperation,
            result.operation.sourceProjectIdAtOperation,
            result.operation.destinationProjectIdAtOperation,
          ].filter(Boolean),
        ),
      ) as string[],
        occurredAt: new Date().toISOString(),
      });

      await this.sendPendingOperationApprovalNotificationsBestEffort({
        operation: result.operation,
        type,
        currentUser,
        approvalPlan: result.approvalPlan,
      });
    }

    return {
      ok: true,
      idempotentReplay: Boolean(result.idempotentReplay),
      message: result.idempotentReplay
        ? 'Operation already exists. Returning the original operation.'
        : this.getPersistedSuccessMessage(type, result.status),
      operationId: result.operation.id,
      operationNo: result.operation.operationNo,
      operationType: type,
      status: result.status,
      occurredAt: result.operation.occurredAt,
      requiresApproval: result.approvalPlan.some((item: ApprovalPlanItem) => item.status === 'PENDING'),
      createdBy: {
        id: currentUser.id,
        name: currentUser.fullName,
        role: currentUser.role,
      },
      approvals: result.approvalPlan,
    };
  }

  private async findExistingIdempotentOperation(
    dto: CreateOperationDto,
    currentUser: CurrentUserContext,
    type: NormalizedOperationType,
  ) {
    const clientOperationId = String(dto.clientOperationId || '').trim();

    if (!clientOperationId || !currentUser.companyId) {
      return null;
    }

    const existing = await (this.prisma as any).operation.findFirst({
      where: {
        companyId: currentUser.companyId,
        clientOperationId,
      },
      include: {
        approvals: {
          select: {
            id: true,
            approverUserId: true,
            projectId: true,
            approvalStage: true,
            status: true,
            note: true,
            reviewedAt: true,
            createdAt: true,
          },
        },
      },
    });

    if (!existing) {
      return null;
    }

    if (existing.requestedByUserId !== currentUser.id) {
      throw new ForbiddenException(
        'clientOperationId is already used by another user.',
      );
    }

    if (this.normalizeOperationType(existing.type) !== type) {
      throw new BadRequestException(
        'clientOperationId was already used for a different operation type.',
      );
    }

    return existing;
  }

  private buildIdempotentCreateResponse(
    operation: any,
    currentUser: CurrentUserContext,
  ) {
    return {
      ok: true,
      idempotentReplay: true,
      message: 'Operation already exists. Returning the original operation.',
      operationId: operation.id,
      operationNo: operation.operationNo,
      operationType: operation.type,
      status: operation.status,
      occurredAt: operation.occurredAt,
      requiresApproval: (operation.approvals || []).some(
        (item: any) => item.status === 'PENDING',
      ),
      createdBy: {
        id: currentUser.id,
        name: currentUser.fullName,
        role: currentUser.role,
      },
      approvals: operation.approvals || [],
    };
  }

  private isClientOperationIdConflict(error: any) {
    if (error?.code !== 'P2002') return false;

    const target = error?.meta?.target;
    const targetText = Array.isArray(target)
      ? target.join(',')
      : String(target || '');

    return targetText.includes('clientOperationId');
  }

  private isOperationNoConflict(error: any) {
    return error?.code === 'P2002' &&
      Array.isArray(error?.meta?.target) &&
      error.meta.target.includes('operationNo');
  }

  private async createDryRun(
    dto: CreateOperationDto,
    currentUser: CurrentUserContext,
    type: NormalizedOperationType,
  ) {
    const approvalDecision = this.getDryRunApprovalDecision({
      user: currentUser,
      type,
      dto,
    });

    return {
      ok: true,
      dryRun: true,
      message: approvalDecision.message,
      operationType: type,
      status: approvalDecision.status,
      requiresApproval: approvalDecision.requiresApproval,
      createdBy: {
        id: currentUser.id,
        name: currentUser.fullName,
        role: currentUser.role,
      },
      nextStep: approvalDecision.nextStep,
      warning:
        'This was a dry run because the supplied user does not exist in the database. Use a real User.id to persist operations.',
      draft: {
        sourceStationId: dto.sourceStationId || null,
        destinationStationId: dto.destinationStationId || null,
        assetId: dto.assetId || null,
        currentProjectId: dto.currentProjectId || null,
        clientOperationId: dto.clientOperationId || null,
        locationLatitude: dto.locationLatitude ?? null,
        locationLongitude: dto.locationLongitude ?? null,
        locationAccuracy: dto.locationAccuracy ?? null,
        locationCapturedAt: dto.locationCapturedAt || null,
        quantity: dto.quantity,
        odometer: dto.odometer ?? null,
        stationCounter: dto.stationCounter ?? null,
        dispenserReadings: dto.dispenserReadings || null,
        dispenserAllocations: dto.dispenserAllocations || null,
        externalStationName: dto.externalStationName || null,
        invoiceNumber: dto.invoiceNumber || null,
        externalInvoiceAmount: dto.externalInvoiceAmount ?? null,
        notes: dto.notes || null,
        attachments: dto.attachments,
      },
    };
  }

  private async resolveAuthenticatedCurrentUser(
    request?: RequestLike,
  ): Promise<CurrentUserContext> {
    const requestUser = request?.user as any;

    /*
      JwtStrategy currently exposes userId from payload.sub.
      id/sub fallbacks are accepted only from the already authenticated request
      object so this method remains compatible if the strategy shape changes.
    */
    const userId = String(
      requestUser?.userId || requestUser?.id || requestUser?.sub || '',
    ).trim();

    if (!userId) {
      throw new UnauthorizedException(
        'Authenticated user identity was not found in the JWT request.',
      );
    }

    const dbUser = await (this.prisma as any).user.findUnique({
      where: { id: userId },
      include: {
        company: { select: { multiProjectEnabled: true } },
        role: true,
        linkedEmployee: {
          select: {
            projectId: true,
            employeeId: true,
            name: true,
            projectAssignments: {
              where: { project: { is: { deletedAt: null, isActive: true } } },
              select: { projectId: true },
            },
          },
        },
        managedProjects: {
          where: { deletedAt: null, isActive: true },
          select: { id: true },
        },
      },
    });

    if (!dbUser) {
      throw new UnauthorizedException(
        'Authenticated user does not exist in the database.',
      );
    }

    if (dbUser.deletedAt) {
      throw new UnauthorizedException(
        'Authenticated user account is no longer available.',
      );
    }

    if (dbUser.isActive === false) {
      throw new UnauthorizedException(
        'Authenticated user account is inactive.',
      );
    }

    return {
      id: dbUser.id,
      fullName:
        dbUser.fullName ||
        dbUser.email ||
        requestUser?.fullName ||
        requestUser?.email ||
        'User',
      role: this.normalizeRole(
        dbUser.role?.name ||
          requestUser?.roleName ||
          requestUser?.role ||
          requestUser?.systemRole,
      ),
      companyId: dbUser.companyId,
      existsInDatabase: true,
      assignedProjectIds: Array.from(
        new Set(
          [
            dbUser.linkedEmployee?.projectId || null,
            ...(dbUser.company?.multiProjectEnabled
              ? (dbUser.linkedEmployee?.projectAssignments || []).map(
                  (assignment: any) => assignment.projectId,
                )
              : []),
          ].filter(Boolean),
        ),
      ) as string[],
      managedProjectIds: dbUser.managedProjects.map(
        (project: any) => project.id,
      ),
      fuelerEmployeeId:
        dbUser.linkedEmployee?.employeeId || dbUser.employeeId || null,
      fuelerName:
        dbUser.linkedEmployee?.name || dbUser.fullName || 'User',
    };
  }

  private async resolveCurrentUser(
    dto: CreateOperationDto,
    request?: RequestLike,
  ): Promise<CurrentUserContext> {
    const requestUser = request?.user as any;
    const userId = requestUser?.id || this.getHeader(request, 'x-user-id') || dto.requestedByUserId;
    const fallbackRole = requestUser?.roleName || requestUser?.role || requestUser?.systemRole ||
      this.getHeader(request, 'x-user-role') || dto.requestedByRole;
    const fallbackName = requestUser?.fullName || requestUser?.name || requestUser?.email ||
      this.getHeader(request, 'x-user-name') || dto.requestedByName;

    if (!userId || !fallbackRole) {
      throw new UnauthorizedException('Current user was not found. Connect AuthGuard or send temporary x-user-id and x-user-role headers for local testing.');
    }

    const dbUser = await (this.prisma as any).user.findUnique({
      where: { id: userId },
      include: {
        company: { select: { multiProjectEnabled: true } },
        role: true,
        linkedEmployee: {
          select: {
            projectId: true,
            employeeId: true,
            name: true,
            projectAssignments: {
              where: { project: { is: { deletedAt: null, isActive: true } } },
              select: { projectId: true },
            },
          },
        },
        managedProjects: { where: { deletedAt: null, isActive: true }, select: { id: true } },
      },
    }).catch(() => null);

    if (dbUser) {
      return {
        id: dbUser.id,
        fullName: dbUser.fullName || dbUser.email || fallbackName || 'User',
        role: this.normalizeRole(dbUser.role?.name || fallbackRole),
        companyId: dbUser.companyId,
        existsInDatabase: true,
        assignedProjectIds: Array.from(
          new Set(
            [
              dbUser.linkedEmployee?.projectId || null,
              ...(dbUser.company?.multiProjectEnabled
                ? (dbUser.linkedEmployee?.projectAssignments || []).map(
                    (assignment: any) => assignment.projectId,
                  )
                : []),
            ].filter(Boolean),
          ),
        ) as string[],
        managedProjectIds: dbUser.managedProjects.map((project: any) => project.id),
        fuelerEmployeeId:
          dbUser.linkedEmployee?.employeeId || dbUser.employeeId || null,
        fuelerName:
          dbUser.linkedEmployee?.name || dbUser.fullName || 'User',
      };
    }

    return {
      id: userId,
      fullName: fallbackName || 'Testing User',
      role: this.normalizeRole(fallbackRole),
      companyId: dto.companyId,
      existsInDatabase: false,
      assignedProjectIds: [],
      managedProjectIds: [],
      fuelerEmployeeId: null,
      fuelerName: fallbackName || 'Testing User',
    };
  }

  private async resolveEntityProjectAt(
    tx: any,
    entityType: 'asset' | 'station',
    entity: any,
    occurredAt: Date,
  ): Promise<{ projectId: string | null; project: any | null }> {
    if (!entity) return { projectId: null, project: null };

    if (entity.createdAt && new Date(entity.createdAt).getTime() > occurredAt.getTime()) {
      throw new UnprocessableEntityException(
        `OFFLINE_ENTITY_CONFLICT: ${entityType === 'asset' ? 'Asset' : 'Station'} did not exist at the operation occurrence time.`,
      );
    }

    const historyModel =
      entityType === 'asset'
        ? tx.assetAssignmentHistory
        : tx.stationAssignmentHistory;
    const entityKey = entityType === 'asset' ? 'assetId' : 'stationId';

    const [latestBeforeOrAt, earliestHistory] = await Promise.all([
      historyModel.findFirst({
        where: {
          [entityKey]: entity.id,
          assignedAt: { lte: occurredAt },
        },
        orderBy: { assignedAt: 'desc' },
        include: { toProject: true },
      }),
      historyModel.findFirst({
        where: { [entityKey]: entity.id },
        orderBy: { assignedAt: 'asc' },
        include: { fromProject: true },
      }),
    ]);

    if (latestBeforeOrAt) {
      return {
        projectId: latestBeforeOrAt.toProjectId || null,
        project: latestBeforeOrAt.toProject || null,
      };
    }

    if (
      earliestHistory &&
      new Date(earliestHistory.assignedAt).getTime() > occurredAt.getTime()
    ) {
      return {
        projectId: earliestHistory.fromProjectId || null,
        project: earliestHistory.fromProject || null,
      };
    }

    return {
      projectId: entity.projectId || null,
      project: entity.project || null,
    };
  }

  private async wasUserAssignedToProjectAt(
    tx: any,
    user: CurrentUserContext,
    projectId: string,
    occurredAt: Date,
  ) {
    if (!user.companyId || !projectId) return false;

    const employee = await tx.employee.findFirst({
      where: {
        linkedUserId: user.id,
        companyId: user.companyId,
        deletedAt: null,
      },
      select: {
        id: true,
        projectId: true,
        projectAssignments: {
          select: { projectId: true, assignedAt: true },
        },
      },
    });

    if (!employee) return false;

    const transfers = await tx.employeeTransferRequest.findMany({
      where: {
        employeeId: employee.id,
        companyId: user.companyId,
        status: 'APPROVED',
        appliedAt: { not: null },
      },
      orderBy: { appliedAt: 'asc' },
      select: {
        fromProjectId: true,
        toProjectId: true,
        appliedAt: true,
      },
    });

    let primaryProjectId =
      transfers.length > 0 ? transfers[0].fromProjectId : employee.projectId;

    for (const transfer of transfers) {
      if (!transfer.appliedAt) continue;
      if (new Date(transfer.appliedAt).getTime() > occurredAt.getTime()) break;
      primaryProjectId = transfer.toProjectId;
    }

    if (primaryProjectId === projectId) return true;

    if (
      employee.projectAssignments.some(
        (assignment: any) =>
          assignment.projectId === projectId &&
          new Date(assignment.assignedAt).getTime() <= occurredAt.getTime(),
      )
    ) {
      return true;
    }

    // Approved removal requests prove that this linked project existed before
    // the removal review time, even though the live assignment row is deleted.
    const laterApprovedRemoval = await tx.employeeProjectRemovalRequest.findFirst({
      where: {
        employeeId: employee.id,
        companyId: user.companyId,
        projectId,
        status: 'APPROVED',
        reviewedAt: { gt: occurredAt },
      },
      select: { id: true },
    });

    return Boolean(laterApprovedRemoval);
  }

  private validateSelectedProjectAgainstHistoricalEntities(
    type: NormalizedOperationType,
    entities: LoadedOperationEntities,
    dto: CreateOperationDto,
  ) {
    const selectedProjectId = String(dto.currentProjectId || '').trim();
    if (!selectedProjectId) return;

    const conflict = (message: string) => {
      throw new UnprocessableEntityException(
        `OFFLINE_ENTITY_CONFLICT: ${message}`,
      );
    };

    if (type === 'DIRECT_REFUEL') {
      if (
        entities.sourceProjectId !== selectedProjectId ||
        entities.assetProjectId !== selectedProjectId
      ) {
        conflict('The source station or asset was not assigned to the selected project at the operation occurrence time.');
      }
      return;
    }

    if (type === 'EXTERNAL_DIRECT_REFUEL') {
      if (entities.assetProjectId !== selectedProjectId) {
        conflict('The asset was not assigned to the selected project at the operation occurrence time.');
      }
      return;
    }

    if (type === 'INTERNAL_TRANSFER') {
      if (
        entities.sourceProjectId !== selectedProjectId ||
        entities.destinationProjectId !== selectedProjectId
      ) {
        conflict('One or both stations were not assigned to the selected project at the operation occurrence time.');
      }
      return;
    }

    if (type === 'EXTERNAL_SUPPLY') {
      if (entities.destinationProjectId !== selectedProjectId) {
        conflict('The destination station was not assigned to the selected project at the operation occurrence time.');
      }
      return;
    }

    if (type === 'EXTERNAL_TRANSFER') {
      if (entities.sourceProjectId !== selectedProjectId) {
        conflict('The source station was not assigned to the selected project at the operation occurrence time.');
      }
      if (entities.destinationProjectId === selectedProjectId) {
        conflict('The destination station belonged to the selected source project at the operation occurrence time.');
      }
    }
  }


  private getStationStructureType(station: any) {
    return String(station?.structureType || 'STANDALONE').trim().toUpperCase();
  }

  private isStationOperationallyActive(station: any) {
    const ownActive = String(station?.status || '').trim().toUpperCase() === 'ACTIVE';
    if (!ownActive) return false;

    if (this.getStationStructureType(station) === 'DISPENSER') {
      return (
        String(station?.parentStation?.status || '').trim().toUpperCase() === 'ACTIVE' &&
        this.getStationStructureType(station?.parentStation) === 'SHARED_TANK'
      );
    }

    return true;
  }

  private async resolveInventoryStation(tx: any, station: any) {
    if (!station) return null;
    if (this.getStationStructureType(station) !== 'DISPENSER') return station;

    const parent = station.parentStation ||
      (station.parentStationId
        ? await tx.station.findFirst({
            where: {
              id: station.parentStationId,
              companyId: station.companyId,
              deletedAt: null,
            },
          })
        : null);

    if (!parent || this.getStationStructureType(parent) !== 'SHARED_TANK') {
      throw new BadRequestException(
        `Dispenser ${station.stationId || station.id} is not linked to a valid SHARED_TANK.`,
      );
    }

    return parent;
  }

  private validateStationStructureForOperation(
    type: NormalizedOperationType,
    entities: LoadedOperationEntities,
    dto: CreateOperationDto,
  ) {
    const sourceType = this.getStationStructureType(entities.sourceStation);
    const destinationType = this.getStationStructureType(entities.destinationStation);
    const hasAllocations =
      Array.isArray(dto.dispenserAllocations) && dto.dispenserAllocations.length > 0;
    const hasReadings =
      Array.isArray(dto.dispenserReadings) && dto.dispenserReadings.length > 0;

    if (entities.sourceStation && !this.isStationOperationallyActive(entities.sourceStation)) {
      throw new BadRequestException('Selected source station is not operationally active.');
    }

    if (entities.destinationStation && !this.isStationOperationallyActive(entities.destinationStation)) {
      throw new BadRequestException('Selected destination station is not operationally active.');
    }

    if (type === 'DIRECT_REFUEL') {
      if (!['STANDALONE', 'DISPENSER', 'SHARED_TANK'].includes(sourceType)) {
        throw new BadRequestException(
          'Direct Refuel source must be a STANDALONE station, active DISPENSER, or SHARED_TANK.',
        );
      }

      if (sourceType !== 'SHARED_TANK' && hasAllocations) {
        throw new BadRequestException(
          'dispenserAllocations are allowed only when the Direct Refuel source is SHARED_TANK.',
        );
      }

      if (hasReadings) {
        throw new BadRequestException(
          'dispenserReadings are not used for Direct Refuel.',
        );
      }
      return;
    }

    if (type === 'EXTERNAL_SUPPLY') {
      if (!['STANDALONE', 'SHARED_TANK'].includes(destinationType)) {
        throw new BadRequestException(
          'External Supply destination must be a STANDALONE station or SHARED_TANK.',
        );
      }

      if (hasAllocations) {
        throw new BadRequestException(
          'dispenserAllocations are not used for External Supply.',
        );
      }

      if (destinationType === 'STANDALONE') {
        if (dto.stationCounter === undefined || dto.stationCounter === null) {
          throw new BadRequestException(
            'stationCounter is required when External Supply destination is STANDALONE.',
          );
        }
        if (hasReadings) {
          throw new BadRequestException(
            'dispenserReadings are allowed only when External Supply destination is SHARED_TANK.',
          );
        }
      } else if (dto.stationCounter !== undefined && dto.stationCounter !== null) {
        throw new BadRequestException(
          'stationCounter must not be sent for a SHARED_TANK destination.',
        );
      }
      return;
    }

    if (type === 'INTERNAL_TRANSFER' || type === 'EXTERNAL_TRANSFER') {
      const displayType =
        type === 'INTERNAL_TRANSFER' ? 'Internal Transfer' : 'External Transfer';

      if (!['STANDALONE', 'DISPENSER', 'SHARED_TANK'].includes(sourceType)) {
        throw new BadRequestException(
          `${displayType} source must be a STANDALONE station, active DISPENSER, or SHARED_TANK.`,
        );
      }

      if (!['STANDALONE', 'SHARED_TANK'].includes(destinationType)) {
        throw new BadRequestException(
          `${displayType} destination must be a STANDALONE station or SHARED_TANK.`,
        );
      }

      if (sourceType !== 'SHARED_TANK' && hasAllocations) {
        throw new BadRequestException(
          `dispenserAllocations are allowed only when the ${displayType} source is SHARED_TANK.`,
        );
      }

      if (destinationType === 'STANDALONE') {
        if (dto.stationCounter === undefined || dto.stationCounter === null) {
          throw new BadRequestException(
            `stationCounter is required for the ${displayType} destination when it is STANDALONE.`,
          );
        }
        if (hasReadings) {
          throw new BadRequestException(
            `dispenserReadings are allowed only when the ${displayType} destination is SHARED_TANK.`,
          );
        }
      } else if (dto.stationCounter !== undefined && dto.stationCounter !== null) {
        throw new BadRequestException(
          `stationCounter must not be sent when the ${displayType} destination is SHARED_TANK.`,
        );
      }

      return;
    }

    if (hasAllocations) {
      throw new BadRequestException(
        'dispenserAllocations are not allowed for this operation type.',
      );
    }

    if (hasReadings) {
      throw new BadRequestException(
        'dispenserReadings are not allowed for this operation type.',
      );
    }
  }

  private async validateSharedTankSourceAllocations(
    tx: any,
    dto: CreateOperationDto,
    sourceStation: any,
  ) {
    if (
      !sourceStation ||
      this.getStationStructureType(sourceStation) !== 'SHARED_TANK'
    ) {
      return;
    }

    const activeDispensers = await tx.station.findMany({
      where: {
        parentStationId: sourceStation.id,
        companyId: sourceStation.companyId,
        deletedAt: null,
        status: 'ACTIVE',
      },
      orderBy: [{ stationId: 'asc' }],
      select: {
        id: true,
        stationId: true,
      },
    });

    if (!activeDispensers.length) {
      throw new BadRequestException(
        'Selected SHARED_TANK has no active dispensers available for this operation.',
      );
    }

    const allocations = Array.isArray(dto.dispenserAllocations)
      ? dto.dispenserAllocations
      : [];

    if (allocations.length !== activeDispensers.length) {
      throw new BadRequestException(
        `SHARED_TANK source requires one quantity allocation for every active dispenser (${activeDispensers.length} required).`,
      );
    }

    const activeById = new Map<string, any>(
      activeDispensers.map((item: any) => [String(item.id), item] as [string, any]),
    );
    const seen = new Set<string>();
    let allocatedTotal = 0;

    for (const allocation of allocations as OperationDispenserAllocationInput[]) {
      const stationId = String(allocation?.stationId || '').trim();
      const quantity = Number(allocation?.quantity);

      if (!stationId || seen.has(stationId)) {
        throw new BadRequestException(
          'Each active source dispenser must have exactly one quantity allocation.',
        );
      }
      seen.add(stationId);

      const dispenser = activeById.get(stationId);
      if (!dispenser) {
        throw new BadRequestException(
          'dispenserAllocations contains a dispenser that is not active under the selected SHARED_TANK.',
        );
      }

      if (!Number.isFinite(quantity) || quantity < 0) {
        throw new BadRequestException(
          `Dispenser ${dispenser.stationId} allocation must be zero or positive.`,
        );
      }

      allocatedTotal += quantity;
    }

    if (allocatedTotal <= 0) {
      throw new BadRequestException(
        'At least one source dispenser allocation must be greater than zero.',
      );
    }

    const operationQuantity = Number(dto.quantity);
    if (Math.abs(allocatedTotal - operationQuantity) > 0.000001) {
      throw new BadRequestException(
        `The sum of dispenserAllocations (${allocatedTotal}) must equal operation quantity (${operationQuantity}).`,
      );
    }
  }

  private async validateSharedTankDispenserReadings(
    tx: any,
    dto: CreateOperationDto,
    destinationStation: any,
  ) {
    if (
      !destinationStation ||
      this.getStationStructureType(destinationStation) !== 'SHARED_TANK'
    ) {
      return;
    }

    const activeDispensers = await tx.station.findMany({
      where: {
        parentStationId: destinationStation.id,
        companyId: destinationStation.companyId,
        deletedAt: null,
        status: 'ACTIVE',
      },
      orderBy: [{ stationId: 'asc' }],
      select: {
        id: true,
        stationId: true,
        currentCounter: true,
        currentLifetimeCounter: true,
        currentCounterCycle: true,
      },
    });

    const readings = Array.isArray(dto.dispenserReadings)
      ? dto.dispenserReadings
      : [];

    if (readings.length !== activeDispensers.length) {
      throw new BadRequestException(
        `SHARED_TANK destination requires one counter reading for every active dispenser (${activeDispensers.length} required).`,
      );
    }

    const seen = new Set<string>();
    const activeById = new Map<string, any>(
      activeDispensers.map((item: any) => [String(item.id), item] as [string, any]),
    );

    for (const reading of readings as OperationDispenserReadingInput[]) {
      const stationId = String(reading?.stationId || '').trim();
      const counter = Number(reading?.counter);

      if (!stationId || seen.has(stationId)) {
        throw new BadRequestException(
          'Each active dispenser must have exactly one counter reading.',
        );
      }
      seen.add(stationId);

      const dispenser = activeById.get(stationId);
      if (!dispenser) {
        throw new BadRequestException(
          'dispenserReadings contains a dispenser that is not active under the selected SHARED_TANK.',
        );
      }

      if (!Number.isFinite(counter) || counter < 0) {
        throw new BadRequestException('Dispenser counter must be zero or positive.');
      }

      const currentCounter = Number(dispenser.currentCounter || 0);
      if (counter < currentCounter) {
        throw new BadRequestException(
          `Dispenser ${dispenser.stationId} counter cannot be lower than current counter ${currentCounter}.`,
        );
      }
    }
  }

  private getOperationCounterEffectiveTime(operation: any) {
    return new Date(operation?.occurredAt || operation?.createdAt || new Date());
  }

  private async hasLaterStandaloneCounterEvent(
    tx: any,
    stationId: string,
    operation: any,
  ) {
    const effectiveAt = this.getOperationCounterEffectiveTime(operation);

    const [laterOperation, laterReset] = await Promise.all([
      tx.operation.findFirst({
        where: {
          id: { not: operation.id },
          status: 'COMPLETED',
          destinationStationId: stationId,
          stationCounter: { not: null },
          type: {
            in: ['INTERNAL_TRANSFER', 'EXTERNAL_SUPPLY', 'EXTERNAL_TRANSFER'],
          },
          occurredAt: { gt: effectiveAt },
        },
        select: { id: true },
      }),
      tx.stationCounterReset.findFirst({
        where: {
          stationId,
          effectiveAt: { gt: effectiveAt },
        },
        select: { id: true },
      }),
    ]);

    return Boolean(laterOperation || laterReset);
  }

  private async hasLaterDispenserCounterEvent(
    tx: any,
    stationId: string,
    operation: any,
  ) {
    const effectiveAt = this.getOperationCounterEffectiveTime(operation);

    const [laterReading, laterReset] = await Promise.all([
      (tx as any).operationStationCounterReading.findFirst({
        where: {
          stationId,
          operationId: { not: operation.id },
          operation: {
            status: 'COMPLETED',
            occurredAt: { gt: effectiveAt },
          },
        },
        select: { id: true },
      }),
      tx.stationCounterReset.findFirst({
        where: {
          stationId,
          effectiveAt: { gt: effectiveAt },
        },
        select: { id: true },
      }),
    ]);

    return Boolean(laterReading || laterReset);
  }

  private async writeAppendOnlyStationCounterSnapshot(
    tx: any,
    operation: any,
    stationId: string,
    counterAfter: number,
  ) {
    const station = await tx.station.findUnique({
      where: { id: stationId },
    });

    if (!station) {
      throw new NotFoundException('Station counter owner was not found.');
    }

    const counterBefore = Number(station.currentCounter || 0);
    const lifetimeBefore = this.getEffectiveStationLifetime(station);
    const counterCycleBefore = Number(station.currentCounterCycle || 1);

    if (!Number.isFinite(counterAfter) || counterAfter < 0) {
      throw new BadRequestException('Station counter must be zero or positive.');
    }

    if (counterAfter < counterBefore) {
      throw new BadRequestException(
        `New station counter cannot be lower than the current counter-cycle reading (${counterBefore}).`,
      );
    }

    const lifetimeAfter =
      lifetimeBefore + (counterAfter - counterBefore);
    const counterCycleAfter = counterCycleBefore;

    await (tx as any).operationStationCounterReading.upsert({
      where: {
        operationId_stationId: {
          operationId: operation.id,
          stationId,
        },
      },
      create: {
        operationId: operation.id,
        companyId: operation.companyId,
        stationId,
        counterValue: counterAfter,
        lifetimeCounter: lifetimeAfter,
        counterCycleNumber: counterCycleAfter,
        counterBefore,
        counterAfter,
        lifetimeBefore,
        lifetimeAfter,
        counterCycleBefore,
        counterCycleAfter,
      },
      update: {
        counterValue: counterAfter,
        lifetimeCounter: lifetimeAfter,
        counterCycleNumber: counterCycleAfter,
        counterBefore,
        counterAfter,
        lifetimeBefore,
        lifetimeAfter,
        counterCycleBefore,
        counterCycleAfter,
      },
    });

    await tx.station.update({
      where: { id: stationId },
      data: {
        currentCounter: counterAfter,
        currentLifetimeCounter: lifetimeAfter,
        currentCounterCycle: counterCycleAfter,
      },
    });

    return {
      lifetimeAfter,
      counterCycleAfter,
    };
  }

  private async rebuildStandaloneStationCounterHistory(
    tx: any,
    stationId: string,
  ) {
    const station = await tx.station.findUnique({
      where: { id: stationId },
    });

    if (!station) {
      throw new NotFoundException('Station was not found.');
    }

    if (station.openingCounter === null || station.openingCounter === undefined) {
      throw new BadRequestException(
        'A backdated station-counter operation cannot be applied until the station Opening Counter is populated.',
      );
    }

    const [operations, resets] = await Promise.all([
      tx.operation.findMany({
        where: {
          status: 'COMPLETED',
          destinationStationId: stationId,
          stationCounter: { not: null },
          type: {
            in: ['INTERNAL_TRANSFER', 'EXTERNAL_SUPPLY', 'EXTERNAL_TRANSFER'],
          },
        },
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          companyId: true,
          stationCounter: true,
          occurredAt: true,
          createdAt: true,
        },
      }),
      tx.stationCounterReset.findMany({
        where: { stationId },
        orderBy: [{ effectiveAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    const events = [
      ...operations.map((item: any) => ({
        kind: 'OPERATION' as const,
        at: item.occurredAt || item.createdAt,
        createdAt: item.createdAt,
        id: item.id,
        item,
      })),
      ...resets.map((item: any) => ({
        kind: 'RESET' as const,
        at: item.effectiveAt,
        createdAt: item.createdAt,
        id: item.id,
        item,
      })),
    ].sort((a, b) => {
      const atDiff = new Date(a.at).getTime() - new Date(b.at).getTime();
      if (atDiff !== 0) return atDiff;
      if (a.kind !== b.kind) return a.kind === 'RESET' ? -1 : 1;
      const createdDiff =
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (createdDiff !== 0) return createdDiff;
      return String(a.id).localeCompare(String(b.id));
    });

    let counter = Number(station.openingCounter || 0);
    let lifetime = counter;
    let cycle = 1;

    for (const event of events) {
      if (event.kind === 'RESET') {
        const nextCounter = Number(event.item.newCounter || 0);

        await tx.stationCounterReset.update({
          where: { id: event.item.id },
          data: {
            oldCounter: counter,
            lifetimeAtReset: lifetime,
            oldCounterCycle: cycle,
            newCounterCycle: cycle + 1,
          },
        });

        cycle += 1;
        counter = nextCounter;
        continue;
      }

      const counterAfter = Number(event.item.stationCounter);

      if (!Number.isFinite(counterAfter) || counterAfter < counter) {
        throw new BadRequestException(
          `Station counter (${counterAfter}) cannot be lower than the previous reading (${counter}) in counter cycle ${cycle}.`,
        );
      }

      const counterBefore = counter;
      const lifetimeBefore = lifetime;
      const counterCycleBefore = cycle;

      lifetime += counterAfter - counterBefore;
      counter = counterAfter;

      await (tx as any).operationStationCounterReading.upsert({
        where: {
          operationId_stationId: {
            operationId: event.item.id,
            stationId,
          },
        },
        create: {
          operationId: event.item.id,
          companyId: event.item.companyId,
          stationId,
          counterValue: counterAfter,
          lifetimeCounter: lifetime,
          counterCycleNumber: cycle,
          counterBefore,
          counterAfter,
          lifetimeBefore,
          lifetimeAfter: lifetime,
          counterCycleBefore,
          counterCycleAfter: cycle,
        },
        update: {
          counterValue: counterAfter,
          lifetimeCounter: lifetime,
          counterCycleNumber: cycle,
          counterBefore,
          counterAfter,
          lifetimeBefore,
          lifetimeAfter: lifetime,
          counterCycleBefore,
          counterCycleAfter: cycle,
        },
      });

      await tx.operation.update({
        where: { id: event.item.id },
        data: {
          lifetimeCounter: lifetime,
          stationCounterCycleNumber: cycle,
        },
      });
    }

    await tx.station.update({
      where: { id: stationId },
      data: {
        currentCounter: counter,
        currentLifetimeCounter: lifetime,
        currentCounterCycle: cycle,
      },
    });
  }

  private async rebuildDispenserCounterHistory(
    tx: any,
    stationId: string,
  ) {
    const station = await tx.station.findUnique({
      where: { id: stationId },
    });

    if (!station || this.getStationStructureType(station) !== 'DISPENSER') {
      throw new NotFoundException('Dispenser station was not found.');
    }

    if (station.openingCounter === null || station.openingCounter === undefined) {
      throw new BadRequestException(
        'A backdated dispenser-counter operation cannot be applied until the dispenser Opening Counter is populated.',
      );
    }

    const [readings, resets] = await Promise.all([
      (tx as any).operationStationCounterReading.findMany({
        where: {
          stationId,
          operation: { status: 'COMPLETED' },
        },
        include: {
          operation: {
            select: {
              id: true,
              companyId: true,
              occurredAt: true,
              createdAt: true,
            },
          },
        },
      }),
      tx.stationCounterReset.findMany({
        where: { stationId },
        orderBy: [{ effectiveAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    const events = [
      ...readings.map((item: any) => ({
        kind: 'READING' as const,
        at:
          item.operation?.occurredAt ||
          item.operation?.createdAt ||
          item.createdAt,
        createdAt: item.operation?.createdAt || item.createdAt,
        id: item.id,
        item,
      })),
      ...resets.map((item: any) => ({
        kind: 'RESET' as const,
        at: item.effectiveAt,
        createdAt: item.createdAt,
        id: item.id,
        item,
      })),
    ].sort((a, b) => {
      const atDiff = new Date(a.at).getTime() - new Date(b.at).getTime();
      if (atDiff !== 0) return atDiff;
      if (a.kind !== b.kind) return a.kind === 'RESET' ? -1 : 1;
      const createdDiff =
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (createdDiff !== 0) return createdDiff;
      return String(a.id).localeCompare(String(b.id));
    });

    let counter = Number(station.openingCounter || 0);
    let lifetime = counter;
    let cycle = 1;

    for (const event of events) {
      if (event.kind === 'RESET') {
        const nextCounter = Number(event.item.newCounter || 0);

        await tx.stationCounterReset.update({
          where: { id: event.item.id },
          data: {
            oldCounter: counter,
            lifetimeAtReset: lifetime,
            oldCounterCycle: cycle,
            newCounterCycle: cycle + 1,
          },
        });

        cycle += 1;
        counter = nextCounter;
        continue;
      }

      const counterAfter = Number(event.item.counterValue);

      if (!Number.isFinite(counterAfter) || counterAfter < counter) {
        throw new BadRequestException(
          `Dispenser counter (${counterAfter}) cannot be lower than the previous reading (${counter}) in counter cycle ${cycle}.`,
        );
      }

      const counterBefore = counter;
      const lifetimeBefore = lifetime;
      const counterCycleBefore = cycle;

      lifetime += counterAfter - counterBefore;
      counter = counterAfter;

      await (tx as any).operationStationCounterReading.update({
        where: { id: event.item.id },
        data: {
          lifetimeCounter: lifetime,
          counterCycleNumber: cycle,
          counterBefore,
          counterAfter,
          lifetimeBefore,
          lifetimeAfter: lifetime,
          counterCycleBefore,
          counterCycleAfter: cycle,
        },
      });
    }

    await tx.station.update({
      where: { id: stationId },
      data: {
        currentCounter: counter,
        currentLifetimeCounter: lifetime,
        currentCounterCycle: cycle,
      },
    });
  }

  private async applyCompletedStationCounterSnapshots(
    tx: any,
    operation: any,
    dto: CreateOperationDto,
    entities: LoadedOperationEntities,
  ) {
    if (
      !['INTERNAL_TRANSFER', 'EXTERNAL_SUPPLY', 'EXTERNAL_TRANSFER'].includes(
        String(operation.type || '').toUpperCase(),
      )
    ) {
      return;
    }

    const destinationStation = await tx.station.findUnique({
      where: { id: operation.destinationStationId },
    });

    if (!destinationStation) {
      throw new NotFoundException('Destination station was not found.');
    }

    if (
      this.getStationStructureType(destinationStation) === 'STANDALONE' &&
      dto.stationCounter !== undefined &&
      dto.stationCounter !== null
    ) {
      const hasLaterEvent = await this.hasLaterStandaloneCounterEvent(
        tx,
        destinationStation.id,
        operation,
      );

      if (hasLaterEvent) {
        await this.rebuildStandaloneStationCounterHistory(
          tx,
          destinationStation.id,
        );
      } else {
        const snapshot = await this.writeAppendOnlyStationCounterSnapshot(
          tx,
          operation,
          destinationStation.id,
          Number(dto.stationCounter),
        );

        await tx.operation.update({
          where: { id: operation.id },
          data: {
            lifetimeCounter: snapshot.lifetimeAfter,
            stationCounterCycleNumber: snapshot.counterCycleAfter,
          },
        });
      }

      return;
    }

    if (
      this.getStationStructureType(destinationStation) === 'SHARED_TANK' &&
      Array.isArray(dto.dispenserReadings) &&
      dto.dispenserReadings.length > 0
    ) {
      for (const reading of dto.dispenserReadings) {
        const stationId = String(reading.stationId);
        const dispenser = await tx.station.findFirst({
          where: {
            id: stationId,
            companyId: operation.companyId,
            deletedAt: null,
            structureType: 'DISPENSER',
            parentStationId: destinationStation.id,
          },
        });

        if (!dispenser) {
          throw new BadRequestException(
            'A destination dispenser reading no longer belongs to the selected SHARED_TANK.',
          );
        }

        const hasLaterEvent = await this.hasLaterDispenserCounterEvent(
          tx,
          dispenser.id,
          operation,
        );

        if (hasLaterEvent) {
          await this.rebuildDispenserCounterHistory(tx, dispenser.id);
        } else {
          await this.writeAppendOnlyStationCounterSnapshot(
            tx,
            operation,
            dispenser.id,
            Number(reading.counter),
          );
        }
      }
    }
  }

  private async loadAndValidateEntities(
    tx: any,
    dto: CreateOperationDto,
    user: CurrentUserContext,
    type: NormalizedOperationType,
    occurredAt: Date,
    options?: {
      skipUserProjectAccess?: boolean;
    },
  ): Promise<LoadedOperationEntities> {
    if (!user.companyId) throw new BadRequestException('User companyId is required.');

    const [sourceStation, destinationStation, asset] = await Promise.all([
      dto.sourceStationId
        ? tx.station.findFirst({
            where: { id: dto.sourceStationId, companyId: user.companyId, deletedAt: null },
            include: { project: true, parentStation: true },
          })
        : Promise.resolve(undefined),
      dto.destinationStationId
        ? tx.station.findFirst({
            where: { id: dto.destinationStationId, companyId: user.companyId, deletedAt: null },
            include: { project: true, parentStation: true },
          })
        : Promise.resolve(undefined),
      dto.assetId
        ? tx.asset.findFirst({
            where: { id: dto.assetId, companyId: user.companyId, deletedAt: null },
            include: { project: true },
          })
        : Promise.resolve(undefined),
    ]);

    if (dto.sourceStationId && !sourceStation) throw new NotFoundException('Source station was not found.');
    if (dto.destinationStationId && !destinationStation) throw new NotFoundException('Destination station was not found.');
    if (dto.assetId && !asset) throw new NotFoundException('Asset was not found.');

    const [sourceAt, destinationAt, assetAt] = await Promise.all([
      this.resolveEntityProjectAt(tx, 'station', sourceStation, occurredAt),
      this.resolveEntityProjectAt(tx, 'station', destinationStation, occurredAt),
      this.resolveEntityProjectAt(tx, 'asset', asset, occurredAt),
    ]);

    const [sourceInventoryStation, destinationInventoryStation] = await Promise.all([
      this.resolveInventoryStation(tx, sourceStation),
      this.resolveInventoryStation(tx, destinationStation),
    ]);

    const entities: LoadedOperationEntities = {
      sourceStation,
      destinationStation,
      asset,
      sourceInventoryStation,
      destinationInventoryStation,
      sourceProjectId: sourceAt.projectId,
      destinationProjectId: destinationAt.projectId,
      assetProjectId: assetAt.projectId,
      sourceProjectAtOperation: sourceAt.project,
      destinationProjectAtOperation: destinationAt.project,
      assetProjectAtOperation: assetAt.project,
    };

    this.validateStationStructureForOperation(type, entities, dto);

    if (
      ['DIRECT_REFUEL', 'INTERNAL_TRANSFER', 'EXTERNAL_TRANSFER'].includes(type)
    ) {
      await this.validateSharedTankSourceAllocations(
        tx,
        dto,
        sourceStation,
      );
    }

    if (
      ['EXTERNAL_SUPPLY', 'INTERNAL_TRANSFER', 'EXTERNAL_TRANSFER'].includes(type)
    ) {
      await this.validateSharedTankDispenserReadings(
        tx,
        dto,
        destinationStation,
      );
    }

    this.validateSelectedProjectAgainstHistoricalEntities(type, entities, dto);
    this.validateProjectRules(type, entities);
    this.validateTankCapacity(type, entities, Number(dto.quantity));

    if (!options?.skipUserProjectAccess) {
      await this.validateUserProjectAccess(
        tx,
        user,
        type,
        entities,
        dto,
        occurredAt,
      );
    }

    return entities;
  }

  private validateTankCapacity(
    type: NormalizedOperationType,
    entities: LoadedOperationEntities,
    quantity: number,
  ) {
    if (!['DIRECT_REFUEL', 'EXTERNAL_DIRECT_REFUEL'].includes(type)) return;
    const capacity = Number(entities.asset?.fuelTankCapacity || 0);
    if (capacity > 0 && quantity > capacity) {
      throw new BadRequestException(`Quantity cannot exceed asset fuel tank capacity (${capacity} L).`);
    }
  }

  private async validateUserProjectAccess(
    tx: any,
    user: CurrentUserContext,
    type: NormalizedOperationType,
    entities: LoadedOperationEntities,
    dto: CreateOperationDto,
    occurredAt: Date,
  ) {
    if (!['Officer', 'Operator', 'Supervisor', 'Manager'].includes(user.role)) return;

    const requiredProjectIds = new Set<string>();
    if (type === 'DIRECT_REFUEL') {
      if (entities.sourceProjectId) requiredProjectIds.add(entities.sourceProjectId);
      if (entities.assetProjectId) requiredProjectIds.add(entities.assetProjectId);
    } else if (type === 'EXTERNAL_DIRECT_REFUEL') {
      if (entities.assetProjectId) requiredProjectIds.add(entities.assetProjectId);
    } else if (type === 'EXTERNAL_SUPPLY') {
      if (entities.destinationProjectId) requiredProjectIds.add(entities.destinationProjectId);
    } else if (type === 'INTERNAL_TRANSFER') {
      if (entities.sourceProjectId) requiredProjectIds.add(entities.sourceProjectId);
    } else if (type === 'EXTERNAL_TRANSFER') {
      if (entities.sourceProjectId) requiredProjectIds.add(entities.sourceProjectId);
    }

    if (user.role === 'Manager') {
      const hasAccess = [...requiredProjectIds].some((id) =>
        user.managedProjectIds.includes(id),
      );
      if (!hasAccess) {
        throw new ForbiddenException(
          'Manager is not assigned to any project involved in this operation.',
        );
      }
      return;
    }

    const accessChecks = await Promise.all(
      [...requiredProjectIds].map(async (id) =>
        user.assignedProjectIds.includes(id)
          ? true
          : this.wasUserAssignedToProjectAt(tx, user, id, occurredAt),
      ),
    );

    if (accessChecks.some((allowed) => !allowed)) {
      throw new UnprocessableEntityException(
        'OFFLINE_ENTITY_CONFLICT: User was not assigned to the operation project at the operation occurrence time.',
      );
    }

    const selectedProjectId = String(dto.currentProjectId || '').trim();

    if (user.assignedProjectIds.length > 1 && !selectedProjectId) {
      throw new BadRequestException(
        'currentProjectId is required for multi-project operations.',
      );
    }

    const effectiveSelectedProjectId =
      selectedProjectId ||
      user.assignedProjectIds[0] ||
      [...requiredProjectIds][0] ||
      '';

    if (
      effectiveSelectedProjectId &&
      !user.assignedProjectIds.includes(effectiveSelectedProjectId)
    ) {
      const hadHistoricalAccess = await this.wasUserAssignedToProjectAt(
        tx,
        user,
        effectiveSelectedProjectId,
        occurredAt,
      );

      if (!hadHistoricalAccess) {
        throw new UnprocessableEntityException(
          'OFFLINE_ENTITY_CONFLICT: Selected project was not assigned to this user at the operation occurrence time.',
        );
      }
    }

    const operationContextProjectId =
      this.getOperationContextProjectId(type, entities);

    if (
      effectiveSelectedProjectId &&
      operationContextProjectId &&
      operationContextProjectId !== effectiveSelectedProjectId
    ) {
      throw new UnprocessableEntityException(
        'OFFLINE_ENTITY_CONFLICT: Operation entities did not belong to the selected project at the operation occurrence time.',
      );
    }
  }

  private getOperationContextProjectId(
    type: NormalizedOperationType,
    entities: LoadedOperationEntities,
  ): string | null {
    if (type === 'DIRECT_REFUEL') {
      return entities.assetProjectId || entities.sourceProjectId || null;
    }

    if (type === 'EXTERNAL_DIRECT_REFUEL') {
      return entities.assetProjectId || null;
    }

    if (type === 'INTERNAL_TRANSFER') {
      return entities.sourceProjectId || entities.destinationProjectId || null;
    }

    if (type === 'EXTERNAL_SUPPLY') {
      return entities.destinationProjectId || null;
    }

    if (type === 'EXTERNAL_TRANSFER') {
      return entities.sourceProjectId || null;
    }

    return null;
  }

  private validateProjectRules(
    type: NormalizedOperationType,
    entities: LoadedOperationEntities,
  ) {
    if (type === 'DIRECT_REFUEL') {
      if (!entities.sourceProjectId || !entities.assetProjectId) {
        throw new BadRequestException('Source station and asset must be assigned to projects for Direct Refuel.');
      }
      if (entities.sourceProjectId !== entities.assetProjectId) {
        throw new BadRequestException('Direct Refuel requires the source station and asset to be in the same project.');
      }
    }

    if (type === 'INTERNAL_TRANSFER') {
      if (!entities.sourceProjectId || !entities.destinationProjectId) {
        throw new BadRequestException(
          'Both stations must be assigned to projects for Internal Transfer.',
        );
      }

      if (entities.sourceProjectId !== entities.destinationProjectId) {
        throw new BadRequestException(
          'Internal Transfer is allowed only between stations inside the same project.',
        );
      }
    }

    if (type === 'EXTERNAL_TRANSFER') {
      if (!entities.sourceProjectId || !entities.destinationProjectId) {
        throw new BadRequestException(
          'Both stations must be assigned to projects for External Transfer.',
        );
      }

      if (entities.sourceProjectId === entities.destinationProjectId) {
        throw new BadRequestException(
          'External Transfer requires two stations in different projects. Use Internal Transfer for same-project transfer.',
        );
      }
    }
  }

  private async buildApprovalPlan(
    tx: any,
    user: CurrentUserContext,
    type: NormalizedOperationType,
    entities: LoadedOperationEntities,
  ): Promise<ApprovalPlanItem[]> {
    if (type === 'EXTERNAL_DIRECT_REFUEL') {
      if (user.role === 'Manager') return [];
      const projectId = entities.assetProjectId;
      const managerId = await this.getProjectManagerId(tx, projectId);
      return [
        {
          approverUserId: managerId,
          projectId: projectId!,
          approvalStage: 'Asset Project Manager',
          status: 'PENDING',
        },
      ];
    }

    if (type === 'EXTERNAL_SUPPLY') {
      if (user.role === 'Manager') return [];
      const projectId = entities.destinationProjectId;
      const managerId = await this.getProjectManagerId(tx, projectId);
      return [
        {
          approverUserId: managerId,
          projectId: projectId!,
          approvalStage: 'Destination Project Manager',
          status: 'PENDING',
        },
      ];
    }

    if (type === 'EXTERNAL_TRANSFER') {
      const sourceProjectId = entities.sourceProjectId;
      const destinationProjectId = entities.destinationProjectId;

      const [sourceManagerId, destinationManagerId] = await Promise.all([
        this.getProjectManagerId(tx, sourceProjectId),
        this.getProjectManagerId(tx, destinationProjectId),
      ]);

      if (sourceManagerId === destinationManagerId) {
        return [
          {
            approverUserId: sourceManagerId,
            projectId: sourceProjectId!,
            approvalStage: 'Source and Destination Project Manager',
            status: user.role === 'Manager' ? 'APPROVED' : 'PENDING',
            reviewedAt: user.role === 'Manager' ? new Date() : null,
          },
        ];
      }

      const sourceStatus =
        user.role === 'Manager' && user.id === sourceManagerId
          ? 'APPROVED'
          : 'PENDING';

      const destinationStatus =
        user.role === 'Manager' && user.id === destinationManagerId
          ? 'APPROVED'
          : 'PENDING';

      return [
        {
          approverUserId: sourceManagerId,
          projectId: sourceProjectId!,
          approvalStage: 'Source Project Manager',
          status: sourceStatus,
          reviewedAt: sourceStatus === 'APPROVED' ? new Date() : null,
        },
        {
          approverUserId: destinationManagerId,
          projectId: destinationProjectId!,
          approvalStage: 'Destination Project Manager',
          status: destinationStatus,
          reviewedAt: destinationStatus === 'APPROVED' ? new Date() : null,
        },
      ];
    }

    return [];
  }

  private async getProjectManagerId(tx: any, projectId?: string | null) {
    if (!projectId) {
      throw new BadRequestException('Project manager routing requires projectId.');
    }

    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: { id: true, projectManagerId: true },
    });

    if (!project) {
      throw new NotFoundException('Project was not found.');
    }

    if (!project.projectManagerId) {
      throw new BadRequestException(
        'Project has no assigned manager. Please assign a project manager first.',
      );
    }

    return project.projectManagerId;
  }

  private getInitialOperationStatus(
    type: NormalizedOperationType,
    user: CurrentUserContext,
    approvalPlan: ApprovalPlanItem[],
  ): OperationDecisionStatus {
    if (!approvalPlan.length) return 'COMPLETED';

    const pendingCount = approvalPlan.filter((item) => item.status === 'PENDING').length;

    if (pendingCount === 0) return 'COMPLETED';

    if (type === 'EXTERNAL_TRANSFER' && user.role === 'Manager') {
      return 'PARTIALLY_APPROVED';
    }

    return 'PENDING';
  }

  private async applyCompletedOperationEffects(
    tx: any,
    args: {
      operation: any;
      dto: CreateOperationDto;
      type: NormalizedOperationType;
      currentUser: CurrentUserContext;
      entities: LoadedOperationEntities;
      useHistoricalAssetMeterPath?: boolean;
    },
  ) {
    const {
      operation,
      dto,
      type,
      currentUser,
      entities,
      useHistoricalAssetMeterPath = false,
    } = args;

    if (type === 'DIRECT_REFUEL') {
      await this.createStockMovement(tx, {
        station: entities.sourceInventoryStation || entities.sourceStation,
        operation,
        movementType: 'DIRECT_REFUEL_OUT',
        quantity: -Math.abs(Number(dto.quantity)),
        reason: 'Direct Refuel operation',
        currentUser,
      });

      if (useHistoricalAssetMeterPath) {
        await this.rebuildAssetLifetimeHistoryForBackdatedOperation(
          tx,
          entities.asset?.id,
        );
      } else {
        await this.updateAssetOdometerIfNeeded(
          tx,
          entities.asset,
          dto.odometer,
          operation.id,
        );
      }
      return;
    }

    if (type === 'EXTERNAL_DIRECT_REFUEL') {
      if (useHistoricalAssetMeterPath) {
        await this.rebuildAssetLifetimeHistoryForBackdatedOperation(
          tx,
          entities.asset?.id,
        );
      } else {
        await this.updateAssetOdometerIfNeeded(
          tx,
          entities.asset,
          dto.odometer,
          operation.id,
        );
      }
      return;
    }

    if (type === 'INTERNAL_TRANSFER') {
      await this.createStockMovement(tx, {
        station: entities.sourceInventoryStation || entities.sourceStation,
        operation,
        movementType: 'INTERNAL_TRANSFER_OUT',
        quantity: -Math.abs(Number(dto.quantity)),
        reason: 'Internal Transfer source station',
        currentUser,
      });

      await this.createStockMovement(tx, {
        station: entities.destinationInventoryStation || entities.destinationStation,
        operation,
        movementType: 'INTERNAL_TRANSFER_IN',
        quantity: Math.abs(Number(dto.quantity)),
        reason: 'Internal Transfer destination station',
        currentUser,
      });

      await this.applyCompletedStationCounterSnapshots(
        tx,
        operation,
        dto,
        entities,
      );
      return;
    }

    if (type === 'EXTERNAL_SUPPLY') {
      await this.createStockMovement(tx, {
        station: entities.destinationInventoryStation || entities.destinationStation,
        operation,
        movementType: 'EXTERNAL_SUPPLY_IN',
        quantity: Math.abs(Number(dto.quantity)),
        reason: 'External Supply operation',
        currentUser,
      });

      await this.applyCompletedStationCounterSnapshots(
        tx,
        operation,
        dto,
        entities,
      );
      return;
    }

    if (type === 'EXTERNAL_TRANSFER') {
      await this.createStockMovement(tx, {
        station: entities.sourceInventoryStation || entities.sourceStation,
        operation,
        movementType: 'EXTERNAL_TRANSFER_OUT',
        quantity: -Math.abs(Number(dto.quantity)),
        reason: 'External Transfer source station',
        currentUser,
      });

      await this.createStockMovement(tx, {
        station: entities.destinationInventoryStation || entities.destinationStation,
        operation,
        movementType: 'EXTERNAL_TRANSFER_IN',
        quantity: Math.abs(Number(dto.quantity)),
        reason: 'External Transfer destination station',
        currentUser,
      });

      await this.applyCompletedStationCounterSnapshots(
        tx,
        operation,
        dto,
        entities,
      );
    }
  }

  private async createStockMovement(
    tx: any,
    args: {
      station: any;
      operation: any;
      movementType: string;
      quantity: number;
      reason: string;
      currentUser: CurrentUserContext;
    },
  ) {
    const { station, operation, movementType, quantity, reason, currentUser } = args;
    if (!station) throw new BadRequestException('Station is required for stock movement.');

    const movementQuantity = Number(quantity || 0);

    /*
      Stock protection is enforced after the atomic database increment/decrement
      inside the same transaction. If the new source balance is below the
      company-configured tolerance, throwing here rolls the whole transaction back.

      This avoids a read-then-write race condition when two operations consume
      stock from the same station at nearly the same time.
    */
    const updatedStation = await tx.station.update({
      where: { id: station.id },
      data: {
        currentStock: { increment: movementQuantity },
      },
      select: {
        currentStock: true,
        capacity: true,
        companyId: true,
      },
    });

    const balanceAfter = Number(updatedStation.currentStock || 0);
    const balanceBefore = balanceAfter - movementQuantity;

    if (movementQuantity < 0) {
      const company = await tx.company.findUnique({
        where: { id: updatedStation.companyId },
        select: {
          stationNegativeTolerancePercent: true,
        },
      });

      const configuredPercent = Number(
        company?.stationNegativeTolerancePercent ?? 2,
      );
      const tolerancePercent =
        Number.isFinite(configuredPercent) &&
        configuredPercent >= 0 &&
        configuredPercent <= 5
          ? configuredPercent
          : 2;

      const stationCapacity = Number(updatedStation.capacity || 0);
      const minimumAllowedBalance =
        stationCapacity > 0
          ? -Math.abs(stationCapacity * (tolerancePercent / 100))
          : 0;

      if (balanceAfter < minimumAllowedBalance - 0.000001) {
        throw new BadRequestException(
          [
            'Operation would exceed the allowed negative station balance.',
            `Current balance: ${balanceBefore.toFixed(2)} L.`,
            `Requested quantity: ${Math.abs(movementQuantity).toFixed(2)} L.`,
            `Expected balance: ${balanceAfter.toFixed(2)} L.`,
            `Minimum allowed balance: ${minimumAllowedBalance.toFixed(2)} L`,
            `(tolerance ${tolerancePercent}% of station capacity ${
              stationCapacity > 0 ? stationCapacity.toFixed(2) : '0.00'
            } L).`,
          ].join(' '),
        );
      }
    }

    await tx.stationStockMovement.create({
      data: {
        stationId: station.id,
        companyId: currentUser.companyId,
        movementType,
        quantity: movementQuantity,
        balanceBefore,
        balanceAfter,
        referenceType: 'Operation',
        referenceId: operation.id,
        reason,
        createdByUserId: currentUser.id,
      },
    });
  }

  private isAssetMeterOperationType(type: NormalizedOperationType) {
    return ['DIRECT_REFUEL', 'EXTERNAL_DIRECT_REFUEL'].includes(type);
  }

  private async shouldUseHistoricalAssetMeterPath(
    tx: any,
    type: NormalizedOperationType,
    assetId: string | undefined,
    occurredAtInput: Date | string | null | undefined,
  ) {
    if (!this.isAssetMeterOperationType(type) || !assetId || !occurredAtInput) {
      return false;
    }

    const occurredAt = new Date(occurredAtInput);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new BadRequestException('occurredAt must be a valid ISO date-time.');
    }

    /*
      Do not compare occurredAt with server now: a normal web/mobile operation
      is naturally captured milliseconds before persistence. Historical mode is
      required only if a later completed meter event/reset already exists.
    */
    const [latestOperation, latestReset] = await Promise.all([
      tx.operation.findFirst({
        where: {
          assetId,
          status: 'COMPLETED',
          odometer: { not: null },
        },
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: { occurredAt: true },
      }),
      tx.assetOdometerReset.findFirst({
        where: { assetId },
        orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: { effectiveAt: true },
      }),
    ]);

    const latestOperationTime = latestOperation?.occurredAt
      ? new Date(latestOperation.occurredAt).getTime()
      : Number.NEGATIVE_INFINITY;
    const latestResetTime = latestReset?.effectiveAt
      ? new Date(latestReset.effectiveAt).getTime()
      : Number.NEGATIVE_INFINITY;

    return occurredAt.getTime() < Math.max(latestOperationTime, latestResetTime);
  }

  private async rebuildAssetLifetimeHistoryForBackdatedOperation(
    tx: any,
    assetId: string | undefined,
  ) {
    if (!assetId) return;

    const asset = await tx.asset.findUnique({
      where: { id: assetId },
      select: {
        id: true,
        currentOdometer: true,
        currentLifetimeOdometer: true,
        currentMeterCycle: true,
      },
    });

    if (!asset) {
      throw new NotFoundException('Asset was not found.');
    }

    const [operations, resets] = await Promise.all([
      tx.operation.findMany({
        where: {
          assetId,
          status: 'COMPLETED',
          odometer: { not: null },
        },
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          odometer: true,
          occurredAt: true,
          createdAt: true,
        },
      }),
      tx.assetOdometerReset.findMany({
        where: { assetId },
        orderBy: [{ effectiveAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          oldOdometer: true,
          newOdometer: true,
          effectiveAt: true,
          createdAt: true,
        },
      }),
    ]);

    const events = [
      ...operations.map((operation: any) => ({
        kind: 'OPERATION' as const,
        at: operation.occurredAt,
        createdAt: operation.createdAt,
        item: operation,
      })),
      ...resets.map((reset: any) => ({
        kind: 'RESET' as const,
        at: reset.effectiveAt,
        createdAt: reset.createdAt,
        item: reset,
      })),
    ].sort((a, b) => {
      const effectiveTime =
        new Date(a.at).getTime() - new Date(b.at).getTime();
      if (effectiveTime !== 0) return effectiveTime;

      const createdTime =
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (createdTime !== 0) return createdTime;

      return a.kind === 'RESET' ? -1 : 1;
    });

    let cycleNumber = 1;
    let lifetimeOdometer: number | null = null;
    let previousReading: number | null = null;
    let latestReading = Number(asset.currentOdometer || 0);
    let hasHistoricalEvent = false;

    for (const event of events) {
      hasHistoricalEvent = true;

      if (event.kind === 'RESET') {
        const reset = event.item;
        const oldMeterCycle = cycleNumber;
        const newMeterCycle = oldMeterCycle + 1;
        const oldReading = Number(reset.oldOdometer || 0);
        const newCycleStartReading = Number(reset.newOdometer || 0);

        if (lifetimeOdometer === null || previousReading === null) {
          lifetimeOdometer = oldReading;
        } else {
          if (oldReading < previousReading) {
            throw new BadRequestException(
              `Reset old odometer (${oldReading}) cannot be lower than the previous reading (${previousReading}) in meter cycle ${cycleNumber}.`,
            );
          }

          lifetimeOdometer =
            Number(lifetimeOdometer || 0) + (oldReading - previousReading);
        }

        await tx.assetOdometerReset.update({
          where: { id: reset.id },
          data: {
            lifetimeAtReset: lifetimeOdometer,
            oldMeterCycle,
            newMeterCycle,
          },
        });

        cycleNumber = newMeterCycle;
        previousReading = newCycleStartReading;
        latestReading = newCycleStartReading;
        continue;
      }

      const reading = Number(event.item.odometer);
      if (!Number.isFinite(reading) || reading < 0) {
        throw new BadRequestException(
          'Historical operation contains an invalid odometer reading.',
        );
      }

      if (previousReading === null) {
        lifetimeOdometer = reading;
        previousReading = reading;
      } else {
        if (reading < previousReading) {
          throw new BadRequestException(
            `Operation odometer (${reading}) cannot be lower than the previous reading (${previousReading}) in meter cycle ${cycleNumber}.`,
          );
        }

        lifetimeOdometer =
          Number(lifetimeOdometer || 0) + (reading - previousReading);
        previousReading = reading;
      }

      latestReading = reading;
      await tx.operation.update({
        where: { id: event.item.id },
        data: {
          lifetimeOdometer,
          assetMeterCycleNumber: cycleNumber,
        },
      });
    }

    if (!hasHistoricalEvent) {
      latestReading = Number(asset.currentOdometer || 0);
      lifetimeOdometer = this.getEffectiveAssetLifetime(asset);
      cycleNumber = Number(asset.currentMeterCycle || 1);
    }

    await tx.asset.update({
      where: { id: assetId },
      data: {
        currentOdometer: latestReading,
        currentLifetimeOdometer: Number(lifetimeOdometer || 0),
        currentMeterCycle: cycleNumber,
      },
    });
  }

  private async updateAssetOdometerIfNeeded(
    tx: any,
    asset: any,
    odometer?: number,
    currentOperationId?: string,
  ) {
    if (!asset || odometer === undefined || odometer === null) return;

    const nextReading = Number(odometer);
    if (!Number.isFinite(nextReading) || nextReading < 0) {
      throw new BadRequestException(
        'New odometer/hour meter must be a valid non-negative number.',
      );
    }

    const operation = currentOperationId
      ? await tx.operation.findUnique({
          where: { id: currentOperationId },
          select: {
            lifetimeOdometer: true,
            assetMeterCycleNumber: true,
          },
        })
      : null;

    const lifetimeOdometer =
      operation?.lifetimeOdometer == null
        ? this.calculateAssetLifetimeSnapshot(asset, nextReading).lifetimeOdometer
        : Number(operation.lifetimeOdometer);

    const meterCycleNumber =
      operation?.assetMeterCycleNumber == null
        ? Number(asset.currentMeterCycle || 1)
        : Number(operation.assetMeterCycleNumber);

    await tx.asset.update({
      where: { id: asset.id },
      data: {
        currentOdometer: nextReading,
        currentLifetimeOdometer: lifetimeOdometer,
        currentMeterCycle: meterCycleNumber,
      },
    });
  }

  private emptyOperationMeterSnapshot(): OperationMeterSnapshot {
    return {
      lifetimeOdometer: null,
      assetMeterCycleNumber: null,
      lifetimeCounter: null,
      stationCounterCycleNumber: null,
    };
  }

  private calculateAssetLifetimeSnapshot(asset: any, nextReading: number) {
    const effectiveCurrentReading = Number(asset?.currentOdometer || 0);

    if (nextReading < effectiveCurrentReading) {
      throw new BadRequestException(
        `New odometer/hour meter cannot be lower than the current meter-cycle reading (${effectiveCurrentReading}).`,
      );
    }

    const currentLifetime = this.getEffectiveAssetLifetime(asset);

    return {
      lifetimeOdometer:
        currentLifetime + (nextReading - effectiveCurrentReading),
      assetMeterCycleNumber: Number(asset?.currentMeterCycle || 1),
    };
  }

  private calculateStationLifetimeSnapshot(station: any, nextReading: number) {
    const effectiveCurrentReading = Number(station?.currentCounter || 0);

    if (nextReading < effectiveCurrentReading) {
      throw new BadRequestException(
        `New station counter cannot be lower than the current counter-cycle reading (${effectiveCurrentReading}).`,
      );
    }

    const currentLifetime = this.getEffectiveStationLifetime(station);

    return {
      lifetimeCounter:
        currentLifetime + (nextReading - effectiveCurrentReading),
      stationCounterCycleNumber: Number(
        station?.currentCounterCycle || 1,
      ),
    };
  }

  private buildOperationMeterSnapshot(
    type: NormalizedOperationType,
    dto: CreateOperationDto,
    entities: LoadedOperationEntities,
  ): OperationMeterSnapshot {
    const snapshot = this.emptyOperationMeterSnapshot();

    if (
      ['DIRECT_REFUEL', 'EXTERNAL_DIRECT_REFUEL'].includes(type) &&
      dto.odometer !== undefined &&
      dto.odometer !== null
    ) {
      Object.assign(
        snapshot,
        this.calculateAssetLifetimeSnapshot(
          entities.asset,
          Number(dto.odometer),
        ),
      );
    }


    return snapshot;
  }

  private getEffectiveAssetLifetime(asset: any) {
    const storedLifetime = Number(asset?.currentLifetimeOdometer || 0);
    const currentReading = Number(asset?.currentOdometer || 0);
    const currentCycle = Number(asset?.currentMeterCycle || 1);

    if (currentCycle === 1 && storedLifetime === 0 && currentReading > 0) {
      return currentReading;
    }

    return storedLifetime;
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

  private getOperationCounterStationId(operation: any) {
    if (operation.type === 'INTERNAL_TRANSFER') return operation.destinationStationId || null;
    if (operation.type === 'EXTERNAL_SUPPLY') return operation.destinationStationId || null;
    if (operation.type === 'EXTERNAL_TRANSFER') return operation.destinationStationId || null;
    return null;
  }


  private buildOperationProjectSnapshot(
    type: NormalizedOperationType,
    entities: LoadedOperationEntities,
  ): OperationProjectSnapshot {
    const sourceProjectId = entities.sourceProjectId || null;
    const sourceProjectName =
      entities.sourceProjectAtOperation?.name ||
      entities.sourceProjectAtOperation?.code ||
      entities.sourceStation?.project?.name ||
      entities.sourceStation?.project?.code ||
      null;

    const destinationProjectId = entities.destinationProjectId || null;
    const destinationProjectName =
      entities.destinationProjectAtOperation?.name ||
      entities.destinationProjectAtOperation?.code ||
      entities.destinationStation?.project?.name ||
      entities.destinationStation?.project?.code ||
      null;

    const assetProjectId = entities.assetProjectId || null;
    const assetProjectName =
      entities.assetProjectAtOperation?.name ||
      entities.assetProjectAtOperation?.code ||
      entities.asset?.project?.name ||
      entities.asset?.project?.code ||
      null;

    let projectIdAtOperation: string | null = null;
    let projectNameAtOperation: string | null = null;

    if (type === 'DIRECT_REFUEL' || type === 'EXTERNAL_DIRECT_REFUEL') {
      projectIdAtOperation = assetProjectId;
      projectNameAtOperation = assetProjectName;
    } else if (type === 'EXTERNAL_SUPPLY') {
      projectIdAtOperation = destinationProjectId;
      projectNameAtOperation = destinationProjectName;
    } else if (type === 'INTERNAL_TRANSFER') {
      projectIdAtOperation = sourceProjectId || destinationProjectId;
      projectNameAtOperation =
        sourceProjectName || destinationProjectName;
    } else if (type === 'EXTERNAL_TRANSFER') {
      // Keep the same primary-project rule currently used for cost:
      // destination first, then source. Source and destination snapshots
      // are also stored independently below.
      projectIdAtOperation = destinationProjectId || sourceProjectId;
      projectNameAtOperation =
        destinationProjectName || sourceProjectName;
    }

    return {
      projectIdAtOperation,
      projectNameAtOperation,
      sourceProjectIdAtOperation: sourceProjectId,
      sourceProjectNameAtOperation: sourceProjectName,
      destinationProjectIdAtOperation: destinationProjectId,
      destinationProjectNameAtOperation: destinationProjectName,
    };
  }

  private getOperationProjectIdForCost(
    type: NormalizedOperationType,
    entities: LoadedOperationEntities,
  ) {
    if (type === 'DIRECT_REFUEL' || type === 'EXTERNAL_DIRECT_REFUEL') {
      return entities.assetProjectId || null;
    }

    if (type === 'EXTERNAL_SUPPLY') {
      return entities.destinationProjectId || null;
    }

    if (type === 'INTERNAL_TRANSFER') {
      return entities.destinationProjectId || entities.sourceProjectId || null;
    }

    if (type === 'EXTERNAL_TRANSFER') {
      return entities.destinationProjectId || entities.sourceProjectId || null;
    }

    return null;
  }

  private async resolveOperationCostSnapshot(
    tx: any,
    args: {
      type: NormalizedOperationType;
      entities: LoadedOperationEntities;
      quantity: number;
      operationDate: Date;
      externalInvoiceAmount?: number;
    },
  ) {
    if (args.type === 'EXTERNAL_DIRECT_REFUEL') {
      const externalInvoiceAmount = Number(args.externalInvoiceAmount || 0);

      return {
        fuelPriceHistoryId: null,
        pricePerLiterAtOperation: null,
        totalCostAtOperation:
          externalInvoiceAmount > 0 ? externalInvoiceAmount : null,
        basePricePerLiterAtOperation: null,
        transportCostPerLiterAtOperation: null,
        vatRateAtOperation: null,
        vatAmountPerLiterAtOperation: null,
        grossPricePerLiterAtOperation: null,
        grossTotalCostAtOperation: null,
      };
    }

    const projectId = this.getOperationProjectIdForCost(args.type, args.entities);

    if (!projectId) {
      return {
        fuelPriceHistoryId: null,
        pricePerLiterAtOperation: null,
        totalCostAtOperation: null,
        basePricePerLiterAtOperation: null,
        transportCostPerLiterAtOperation: null,
        vatRateAtOperation: null,
        vatAmountPerLiterAtOperation: null,
        grossPricePerLiterAtOperation: null,
        grossTotalCostAtOperation: null,
      };
    }

    const effectivePrice = await tx.projectFuelPriceHistory.findFirst({
      where: {
        projectId,
        effectiveFrom: {
          lte: args.operationDate,
        },
      },
      orderBy: {
        effectiveFrom: 'desc',
      },
    });

    if (effectivePrice) {
      const pricePerLiterAtOperation = Number(effectivePrice.pricePerLiter);
      const totalCostAtOperation = Number(args.quantity || 0) * pricePerLiterAtOperation;
      const basePricePerLiterAtOperation =
        effectivePrice.basePricePerLiter == null
          ? null
          : Number(effectivePrice.basePricePerLiter);
      const transportCostPerLiterAtOperation =
        effectivePrice.transportCost == null
          ? null
          : Number(effectivePrice.transportCost);
      const vatRateAtOperation =
        effectivePrice.vatRate == null
          ? null
          : Number(effectivePrice.vatRate);
      const vatAmountPerLiterAtOperation =
        effectivePrice.vatAmountPerLiter == null
          ? null
          : Number(effectivePrice.vatAmountPerLiter);
      const grossPricePerLiterAtOperation =
        effectivePrice.grossPricePerLiter == null
          ? null
          : Number(effectivePrice.grossPricePerLiter);

      return {
        fuelPriceHistoryId: effectivePrice.id,
        pricePerLiterAtOperation,
        totalCostAtOperation,
        basePricePerLiterAtOperation,
        transportCostPerLiterAtOperation,
        vatRateAtOperation,
        vatAmountPerLiterAtOperation,
        grossPricePerLiterAtOperation,
        grossTotalCostAtOperation:
          grossPricePerLiterAtOperation == null
            ? null
            : Number(args.quantity || 0) * grossPricePerLiterAtOperation,
      };
    }

    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: { currentFuelPrice: true },
    });

    const fallbackPrice = Number(project?.currentFuelPrice || 0);

    if (fallbackPrice > 0) {
      return {
        fuelPriceHistoryId: null,
        pricePerLiterAtOperation: fallbackPrice,
        totalCostAtOperation: Number(args.quantity || 0) * fallbackPrice,
        basePricePerLiterAtOperation: null,
        transportCostPerLiterAtOperation: null,
        vatRateAtOperation: null,
        vatAmountPerLiterAtOperation: null,
        grossPricePerLiterAtOperation: null,
        grossTotalCostAtOperation: null,
      };
    }

    return {
      fuelPriceHistoryId: null,
      pricePerLiterAtOperation: null,
      totalCostAtOperation: null,
      basePricePerLiterAtOperation: null,
      transportCostPerLiterAtOperation: null,
      vatRateAtOperation: null,
      vatAmountPerLiterAtOperation: null,
      grossPricePerLiterAtOperation: null,
      grossTotalCostAtOperation: null,
    };
  }

  private async generateOperationNo(tx: any, companyId: string) {
    const latest = await tx.operation.findFirst({
      where: { companyId },
      orderBy: { operationNo: 'desc' },
      select: { operationNo: true },
    });
    const current = Number(String(latest?.operationNo || '').replace(/\D/g, '')) || 0;
    return `OP-${String(current + 1).padStart(6, '0')}`;
  }

  private getPersistedSuccessMessage(
    type: NormalizedOperationType,
    status: OperationDecisionStatus,
  ) {
    if (status === 'PENDING') {
      if (type === 'EXTERNAL_DIRECT_REFUEL') {
        return 'External Direct Refuel request created and pending manager approval.';
      }
      if (type === 'EXTERNAL_SUPPLY') {
        return 'External Supply request created and pending manager approval.';
      }
      if (type === 'EXTERNAL_TRANSFER') {
        return 'External Transfer request created and pending project managers approval.';
      }
    }

    if (status === 'PARTIALLY_APPROVED') {
      return 'External Transfer created with first manager approval and pending the second project manager.';
    }

    return `${this.toDisplayType(type)} completed successfully.`;
  }

  private toDisplayType(type: NormalizedOperationType) {
    return type
      .toLowerCase()
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  private getHeader(request: RequestLike | undefined, name: string) {
    const value = request?.headers?.[name] || request?.headers?.[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  private normalizeRole(value: any): NormalizedRole {
    const compact = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '');

    if (compact === 'platformuser' || compact === 'platformadmin') {
      return 'PlatformAdmin';
    }
    if (compact === 'topmanagement') return 'TopManagement';
    if (compact === 'admin') return 'Admin';
    if (compact === 'manager') return 'Manager';
    if (compact === 'supervisor') return 'Supervisor';
    if (compact === 'officer') return 'Officer';
    if (compact === 'operator') return 'Operator';

    throw new ForbiddenException(`Unsupported role: ${value}`);
  }

  private normalizeOperationType(value: any): NormalizedOperationType {
    const compact = String(value || '')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');

    if (compact === 'DIRECT_REFUEL') return 'DIRECT_REFUEL';
    if (compact === 'EXTERNAL_DIRECT_REFUEL') return 'EXTERNAL_DIRECT_REFUEL';
    if (compact === 'INTERNAL_TRANSFER') return 'INTERNAL_TRANSFER';
    if (compact === 'EXTERNAL_SUPPLY') return 'EXTERNAL_SUPPLY';
    if (compact === 'EXTERNAL_TRANSFER') return 'EXTERNAL_TRANSFER';

    throw new BadRequestException(`Unsupported operation type: ${value}`);
  }

  private validateRoleCanCreateAnyOperation(user: CurrentUserContext) {
    if (['Admin', 'Officer', 'TopManagement', 'PlatformAdmin'].includes(user.role)) {
      throw new ForbiddenException(
        `${user.role} is view-only in Operations and cannot create fuel operations.`,
      );
    }

    if (!['Operator', 'Supervisor', 'Manager'].includes(user.role)) {
      throw new ForbiddenException('This role cannot create operations.');
    }
  }

  private validateRoleCanCreateOperationType(
    user: CurrentUserContext,
    type: NormalizedOperationType,
  ) {
    if (user.role === 'Operator' && type !== 'DIRECT_REFUEL') {
      throw new ForbiddenException(
        'Operator can create Direct Refuel operations only.',
      );
    }

    if (user.role === 'Supervisor') return;
    if (user.role === 'Manager') return;
  }

  private async loadAndValidatePendingPhotoDrafts(
    attachments: unknown,
    currentUser: CurrentUserContext,
    type: NormalizedOperationType,
  ) {
    if (!currentUser.companyId) {
      throw new UnauthorizedException(
        'Authenticated user company was not found.',
      );
    }

    if (!Array.isArray(attachments) || attachments.length !== 3) {
      throw new BadRequestException(
        'Exactly three required operation photos must be uploaded before saving the operation.',
      );
    }

    const paths = attachments.map((attachment: any) =>
      String(attachment?.path || '').trim(),
    );

    if (paths.some((path) => !path) || new Set(paths).size !== paths.length) {
      throw new BadRequestException(
        'Operation photo attachments must contain three unique uploaded storage paths.',
      );
    }

    const drafts = await (this.prisma as any).operationPhotoDraft.findMany({
      where: {
        companyId: currentUser.companyId,
        uploadedByUserId: currentUser.id,
        status: 'PENDING',
        operationId: null,
        path: { in: paths },
      },
    });

    if (drafts.length !== paths.length) {
      throw new BadRequestException(
        'One or more operation photos are invalid, already used, or do not belong to the authenticated user.',
      );
    }

    const draftsByPath = new Map(
      drafts.map((draft: any) => [String(draft.path), draft]),
    );
    const orderedDrafts = paths.map((path) => draftsByPath.get(path));

    if (orderedDrafts.some((draft) => !draft)) {
      throw new BadRequestException(
        'One or more operation photo drafts could not be resolved.',
      );
    }

    // Re-validate the required photo package using authoritative DB draft metadata,
    // not photoType values supplied by the client.
    this.validateRequiredPhotosByType(
      type,
      orderedDrafts.map((draft: any) => ({
        photoType: draft.photoType,
        path: draft.path,
      })),
    );

    return orderedDrafts;
  }

  private buildConsumedOperationAttachments(
    submittedAttachments: unknown,
    drafts: any[],
  ) {
    const submitted = Array.isArray(submittedAttachments)
      ? submittedAttachments
      : [];

    return drafts.map((draft: any, index: number) => {
      const displayMetadata = submitted[index] as any;

      return {
        key: displayMetadata?.key || draft.photoType,
        label: displayMetadata?.label || draft.photoType,
        draftId: draft.id,
        draftStatus: 'CONSUMED',
        fileName: draft.fileName,
        path: draft.path,
        bucket: draft.bucket,
        photoType: draft.photoType,
        ownerType: draft.ownerType,
        ownerCode: draft.ownerCode,
        captureSource: draft.captureSource,
        mimeType: draft.mimeType,
        size: draft.sizeBytes,
        sizeBytes: draft.sizeBytes,
      };
    });
  }

  private async consumeOperationPhotoDrafts(
    tx: any,
    drafts: any[],
    currentUser: CurrentUserContext,
    operationId: string,
  ) {
    if (!currentUser.companyId) {
      throw new UnauthorizedException(
        'Authenticated user company was not found.',
      );
    }

    const draftIds = drafts.map((draft: any) => draft.id);
    const consumedAt = new Date();

    const consumed = await (tx as any).operationPhotoDraft.updateMany({
      where: {
        id: { in: draftIds },
        companyId: currentUser.companyId,
        uploadedByUserId: currentUser.id,
        status: 'PENDING',
        operationId: null,
      },
      data: {
        status: 'CONSUMED',
        operationId,
        consumedAt,
      },
    });

    if (consumed.count !== draftIds.length) {
      throw new BadRequestException(
        'One or more operation photos were already used or changed before the operation could be saved.',
      );
    }
  }

  private validateRequiredPhotosByType(
    type: NormalizedOperationType,
    attachments: unknown,
  ) {
    const requiredPhotoTypes: Record<NormalizedOperationType, string[]> = {
      DIRECT_REFUEL: ['odometer', 'asset', 'asset-meter'],
      EXTERNAL_DIRECT_REFUEL: ['invoice', 'asset-meter', 'asset'],
      INTERNAL_TRANSFER: [
        'destination-meter',
        'station-number',
        'fuel-quantity',
      ],
      EXTERNAL_SUPPLY: ['destination-meter', 'station-number', 'invoice'],
      EXTERNAL_TRANSFER: [
        'source-meter',
        'destination-meter',
        'fuel-quantity',
      ],
    };

    if (!Array.isArray(attachments) || attachments.length !== 3) {
      throw new BadRequestException(
        'Exactly three required operation photos must be uploaded before saving the operation.',
      );
    }

    const normalizedAttachments = attachments.map((attachment: any) => ({
      photoType: String(
        attachment?.photoType || attachment?.type || attachment?.key || '',
      )
        .trim()
        .toLowerCase(),
      path: String(attachment?.path || '').trim(),
    }));

    if (normalizedAttachments.some((attachment) => !attachment.path)) {
      throw new BadRequestException(
        'Every required operation photo must have a valid uploaded storage path.',
      );
    }

    const expectedTypes = requiredPhotoTypes[type];
    const receivedTypes = normalizedAttachments.map(
      (attachment) => attachment.photoType,
    );

    const missingTypes = expectedTypes.filter(
      (photoType) => !receivedTypes.includes(photoType),
    );
    const unexpectedTypes = receivedTypes.filter(
      (photoType) => !expectedTypes.includes(photoType),
    );
    const uniqueTypes = new Set(receivedTypes);

    if (missingTypes.length || unexpectedTypes.length || uniqueTypes.size !== 3) {
      throw new BadRequestException(
        `Invalid operation photo package for ${this.toDisplayType(type)}. Required photo types: ${expectedTypes.join(', ')}.`,
      );
    }
  }

  private validateRequiredFieldsByType(
    type: NormalizedOperationType,
    dto: CreateOperationDto,
  ) {
    if (!dto.quantity || Number(dto.quantity) <= 0) {
      throw new BadRequestException('Diesel quantity must be greater than zero.');
    }

    if (type === 'DIRECT_REFUEL') {
      this.require(dto.sourceStationId, 'sourceStationId is required for Direct Refuel.');
      this.require(dto.assetId, 'assetId is required for Direct Refuel.');
      this.requireNumber(dto.odometer, 'odometer is required for Direct Refuel.');
      return;
    }

    if (type === 'EXTERNAL_DIRECT_REFUEL') {
      this.require(dto.assetId, 'assetId is required for External Direct Refuel.');
      this.requireNumber(
        dto.odometer,
        'odometer is required for External Direct Refuel.',
      );
      this.require(
        dto.externalStationName,
        'externalStationName is required for External Direct Refuel.',
      );
      this.require(
        dto.invoiceNumber,
        'invoiceNumber is required for External Direct Refuel.',
      );
      this.requireNumber(
        dto.externalInvoiceAmount,
        'externalInvoiceAmount is required for External Direct Refuel.',
      );
      if (Number(dto.externalInvoiceAmount) <= 0) {
        throw new BadRequestException(
          'External invoice amount must be greater than zero.',
        );
      }
      return;
    }

    if (type === 'INTERNAL_TRANSFER') {
      this.require(
        dto.sourceStationId,
        'sourceStationId is required for Internal Transfer.',
      );
      this.require(
        dto.destinationStationId,
        'destinationStationId is required for Internal Transfer.',
      );

      if (dto.sourceStationId === dto.destinationStationId) {
        throw new BadRequestException(
          'Source and destination stations cannot be the same.',
        );
      }
      return;
    }

    if (type === 'EXTERNAL_SUPPLY') {
      this.require(
        dto.destinationStationId,
        'destinationStationId is required for External Supply.',
      );
      this.require(
        dto.externalStationName,
        'externalStationName is required for External Supply.',
      );
      this.require(
        dto.invoiceNumber,
        'invoiceNumber is required for External Supply.',
      );
      return;
    }

    if (type === 'EXTERNAL_TRANSFER') {
      this.require(
        dto.sourceStationId,
        'sourceStationId is required for External Transfer.',
      );
      this.require(
        dto.destinationStationId,
        'destinationStationId is required for External Transfer.',
      );

      if (dto.sourceStationId === dto.destinationStationId) {
        throw new BadRequestException(
          'Source and destination stations cannot be the same.',
        );
      }
      return;
    }
  }

  private getDryRunApprovalDecision(args: {
    user: CurrentUserContext;
    type: NormalizedOperationType;
    dto: CreateOperationDto;
  }) {
    const { user, type } = args;

    if (type === 'DIRECT_REFUEL') {
      return {
        status: 'COMPLETED',
        requiresApproval: false,
        message: 'Direct Refuel completed successfully.',
        nextStep: 'Create operation record and decrease source station stock.',
      };
    }

    if (type === 'INTERNAL_TRANSFER') {
      return {
        status: 'COMPLETED',
        requiresApproval: false,
        message: 'Internal Transfer completed successfully.',
        nextStep:
          'Create operation record, decrease source station stock, and increase destination station stock.',
      };
    }

    if (type === 'EXTERNAL_DIRECT_REFUEL') {
      if (user.role === 'Supervisor') {
        return {
          status: 'PENDING',
          requiresApproval: true,
          message:
            'External Direct Refuel request created and pending asset project manager approval.',
          nextStep:
            'Create operation as Pending and route approval to the manager of the asset project.',
        };
      }

      return {
        status: 'COMPLETED',
        requiresApproval: false,
        message: 'External Direct Refuel completed successfully by Manager.',
        nextStep:
          'Create completed operation and include it in asset consumption reports only.',
      };
    }

    if (type === 'EXTERNAL_SUPPLY') {
      if (user.role === 'Supervisor') {
        return {
          status: 'PENDING',
          requiresApproval: true,
          message:
            'External Supply request created and pending destination station project manager approval.',
          nextStep:
            'Create operation as Pending and route approval to the manager of the destination station project.',
        };
      }

      return {
        status: 'COMPLETED',
        requiresApproval: false,
        message: 'External Supply completed successfully by Manager.',
        nextStep:
          'Create completed operation and increase destination station stock.',
      };
    }

    if (type === 'EXTERNAL_TRANSFER') {
      return {
        status: user.role === 'Manager' ? 'PARTIALLY_APPROVED' : 'PENDING',
        requiresApproval: true,
        message:
          user.role === 'Manager'
            ? 'External Transfer created with first manager approval and pending the second project manager.'
            : 'External Transfer request created and pending both project managers approval.',
        nextStep:
          'Create operation and route approval to source and destination project managers.',
      };
    }

    throw new BadRequestException('Unsupported operation type.');
  }

  private require(value: any, message: string) {
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new BadRequestException(message);
    }
  }

  private requireNumber(value: any, message: string) {
    if (value === undefined || value === null || Number.isNaN(Number(value))) {
      throw new BadRequestException(message);
    }
  }
}
