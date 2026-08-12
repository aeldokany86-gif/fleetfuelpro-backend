import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOperationDto } from './dto/create-operation.dto';
import { ReviewOperationDto } from './dto/review-operation.dto';

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
  assignedProjectId?: string | null;
  managedProjectIds: string[];
  fuelerEmployeeId: string | null;
  fuelerName: string;
};

type LoadedOperationEntities = {
  sourceStation?: any;
  destinationStation?: any;
  asset?: any;
  sourceProjectId?: string | null;
  destinationProjectId?: string | null;
  assetProjectId?: string | null;
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

@Injectable()
export class OperationsService {
  constructor(private readonly prisma: PrismaService) {}

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
        },
      },

      destinationStation: {
        select: {
          id: true,
          stationId: true,
          name: true,
          projectId: true,
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

  async create(dto: CreateOperationDto, request?: RequestLike) {
    const currentUser = await this.resolveCurrentUser(dto, request);
    const type = this.normalizeOperationType(dto.type);

    this.validateRoleCanCreateAnyOperation(currentUser);
    this.validateRoleCanCreateOperationType(currentUser, type);
    this.validateRequiredFieldsByType(type, dto);

    /*
      If you test with fake headers such as op-001/mgr-001, the user does not exist in DB.
      v2 needs real User IDs because Operation.requestedByUserId is a FK.
    */
    if (!currentUser.existsInDatabase) {
      return this.createDryRun(dto, currentUser, type);
    }

    return this.createPersistedOperation(dto, currentUser, type);
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
      include: { approvals: true },
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

    const operationDto = {
      type: operation.type,
      sourceStationId: operation.sourceStationId || undefined,
      destinationStationId: operation.destinationStationId || undefined,
      assetId: operation.assetId || undefined,
      quantity: Number(operation.quantity),
      odometer: operation.odometer == null ? undefined : Number(operation.odometer),
      stationCounter: operation.stationCounter == null ? undefined : Number(operation.stationCounter),
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
        )
      : undefined;

    const meterSnapshot =
      action === 'APPROVE' && entities
        ? this.buildOperationMeterSnapshot(
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
        const rejected = await (tx as any).operation.updateMany({
          where: { id: operation.id, status: { in: ['PENDING', 'PARTIALLY_APPROVED'] } },
          data: { status: 'REJECTED', rejectedAt: new Date() },
        });
        if (rejected.count !== 1) {
          throw new BadRequestException('Operation status changed before this review was completed.');
        }
        return { status: 'REJECTED', completedNow: false, rejectedNow: true };
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
      });
      return { status: 'COMPLETED', completedNow: true, rejectedNow: false };
    }, { maxWait: 10000, timeout: 15000 });

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
      createdAt: 'desc',
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

      approvals: {
        some: {
          approverUserId: currentUser.id,
          status: 'PENDING',
        },
      },
    },

    include: this.buildOperationListInclude(),

    orderBy: {
      createdAt: 'desc',
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

  const createdAt: Record<string, Date> = {};
  if (filters.dateFrom) {
    const from = new Date(filters.dateFrom);
    if (Number.isNaN(from.getTime())) {
      throw new BadRequestException('dateFrom is invalid');
    }
    createdAt.gte = from;
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    if (Number.isNaN(to.getTime())) {
      throw new BadRequestException('dateTo is invalid');
    }
    to.setHours(23, 59, 59, 999);
    createdAt.lte = to;
  }

  const accessibleProjectIds =
    currentUser.role === 'Manager'
      ? currentUser.managedProjectIds
      : ['Operator', 'Supervisor'].includes(currentUser.role) &&
          currentUser.assignedProjectId
        ? [currentUser.assignedProjectId]
        : [];
  const scopedProjectIds = filters.projectId
    ? [filters.projectId]
    : accessibleProjectIds;
  const needsProjectScope = ['Manager', 'Operator', 'Supervisor'].includes(
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
      ...(Object.keys(createdAt).length ? { createdAt } : {}),
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
    orderBy: { createdAt: 'desc' },
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

  private async createPersistedOperation(
    dto: CreateOperationDto,
    currentUser: CurrentUserContext,
    type: NormalizedOperationType,
  ) {
    const operationDate = new Date();

    const entities = await this.loadAndValidateEntities(
      this.prisma as any,
      dto,
      currentUser,
      type,
    );

    const approvalPlan = await this.buildApprovalPlan(
      this.prisma as any,
      currentUser,
      type,
      entities,
    );

    const status = this.getInitialOperationStatus(type, currentUser, approvalPlan);
    const completedAt = status === 'COMPLETED' ? operationDate : null;

    const costSnapshot = await this.resolveOperationCostSnapshot(
      this.prisma as any,
      {
        type,
        entities,
        quantity: Number(dto.quantity),
        operationDate,
        externalInvoiceAmount: dto.externalInvoiceAmount,
      },
    );

    const projectSnapshot = this.buildOperationProjectSnapshot(
      type,
      entities,
    );

    // Calculate meter snapshots before opening the interactive transaction.
    // This keeps the transaction focused on writes and avoids Supabase pooler timeouts.
    const meterSnapshot =
      status === 'COMPLETED'
        ? this.buildOperationMeterSnapshot(type, dto, entities)
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
              attachments: dto.attachments || undefined,
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
              completedAt,
              approvedAt:
                status === 'COMPLETED' || status === 'PARTIALLY_APPROVED'
                  ? operationDate
                  : null,
            },
          });

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
            });
          }

          return { operation, status, approvalPlan };
        }, { maxWait: 10000, timeout: 15000 });
        break;
      } catch (error: any) {
        lastError = error;
        if (!this.isOperationNoConflict(error) || attempt === 3) throw error;
      }
    }

    if (!result) throw lastError;

    return {
      ok: true,
      message: this.getPersistedSuccessMessage(type, result.status),
      operationId: result.operation.id,
      operationNo: result.operation.operationNo,
      operationType: type,
      status: result.status,
      requiresApproval: result.approvalPlan.some((item: ApprovalPlanItem) => item.status === 'PENDING'),
      createdBy: {
        id: currentUser.id,
        name: currentUser.fullName,
        role: currentUser.role,
      },
      approvals: result.approvalPlan,
    };
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
        quantity: dto.quantity,
        odometer: dto.odometer ?? null,
        stationCounter: dto.stationCounter ?? null,
        externalStationName: dto.externalStationName || null,
        invoiceNumber: dto.invoiceNumber || null,
        externalInvoiceAmount: dto.externalInvoiceAmount ?? null,
        notes: dto.notes || null,
      },
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
        role: true,
        linkedEmployee: {
          select: { projectId: true, employeeId: true, name: true },
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
        assignedProjectId: dbUser.linkedEmployee?.projectId || null,
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
      assignedProjectId: null,
      managedProjectIds: [],
      fuelerEmployeeId: null,
      fuelerName: fallbackName || 'Testing User',
    };
  }

  private async loadAndValidateEntities(
    tx: any,
    dto: CreateOperationDto,
    user: CurrentUserContext,
    type: NormalizedOperationType,
  ): Promise<LoadedOperationEntities> {
    if (!user.companyId) throw new BadRequestException('User companyId is required.');

    const [sourceStation, destinationStation, asset] = await Promise.all([
      dto.sourceStationId
        ? tx.station.findFirst({
            where: { id: dto.sourceStationId, companyId: user.companyId, deletedAt: null },
            include: { project: true },
          })
        : Promise.resolve(undefined),
      dto.destinationStationId
        ? tx.station.findFirst({
            where: { id: dto.destinationStationId, companyId: user.companyId, deletedAt: null },
            include: { project: true },
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

    const entities: LoadedOperationEntities = {
      sourceStation,
      destinationStation,
      asset,
      sourceProjectId: sourceStation?.projectId || null,
      destinationProjectId: destinationStation?.projectId || null,
      assetProjectId: asset?.projectId || null,
    };

    this.validateProjectRules(type, entities);
    this.validateTankCapacity(type, entities, Number(dto.quantity));
    this.validateUserProjectAccess(user, type, entities);
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

  private validateUserProjectAccess(
    user: CurrentUserContext,
    type: NormalizedOperationType,
    entities: LoadedOperationEntities,
  ) {
    if (!['Operator', 'Supervisor', 'Manager'].includes(user.role)) return;

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
      if (entities.destinationProjectId) requiredProjectIds.add(entities.destinationProjectId);
    }

    if (user.role === 'Manager') {
      const hasAccess = [...requiredProjectIds].some((id) => user.managedProjectIds.includes(id));
      if (!hasAccess) throw new ForbiddenException('Manager is not assigned to any project involved in this operation.');
      return;
    }

    if (!user.assignedProjectId || !requiredProjectIds.has(user.assignedProjectId)) {
      throw new ForbiddenException('User can create operations for the assigned project only.');
    }
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
    },
  ) {
    const { operation, dto, type, currentUser, entities } = args;

    if (type === 'DIRECT_REFUEL') {
      await this.createStockMovement(tx, {
        station: entities.sourceStation,
        operation,
        movementType: 'DIRECT_REFUEL_OUT',
        quantity: -Math.abs(Number(dto.quantity)),
        reason: 'Direct Refuel operation',
        currentUser,
      });

      await this.updateAssetOdometerIfNeeded(
        tx,
        entities.asset,
        dto.odometer,
        operation.id,
      );
      return;
    }

    if (type === 'EXTERNAL_DIRECT_REFUEL') {
      await this.updateAssetOdometerIfNeeded(
        tx,
        entities.asset,
        dto.odometer,
        operation.id,
      );
      return;
    }

    if (type === 'INTERNAL_TRANSFER') {
      await this.createStockMovement(tx, {
        station: entities.sourceStation,
        operation,
        movementType: 'INTERNAL_TRANSFER_OUT',
        quantity: -Math.abs(Number(dto.quantity)),
        reason: 'Internal Transfer source station',
        currentUser,
      });

      await this.createStockMovement(tx, {
        station: entities.destinationStation,
        operation,
        movementType: 'INTERNAL_TRANSFER_IN',
        quantity: Math.abs(Number(dto.quantity)),
        reason: 'Internal Transfer destination station',
        currentUser,
      });
      return;
    }

    if (type === 'EXTERNAL_SUPPLY') {
      await this.createStockMovement(tx, {
        station: entities.destinationStation,
        operation,
        movementType: 'EXTERNAL_SUPPLY_IN',
        quantity: Math.abs(Number(dto.quantity)),
        reason: 'External Supply operation',
        currentUser,
      });
      return;
    }

    if (type === 'EXTERNAL_TRANSFER') {
      await this.createStockMovement(tx, {
        station: entities.sourceStation,
        operation,
        movementType: 'EXTERNAL_TRANSFER_OUT',
        quantity: -Math.abs(Number(dto.quantity)),
        reason: 'External Transfer source station',
        currentUser,
      });

      await this.createStockMovement(tx, {
        station: entities.destinationStation,
        operation,
        movementType: 'EXTERNAL_TRANSFER_IN',
        quantity: Math.abs(Number(dto.quantity)),
        reason: 'External Transfer destination station',
        currentUser,
      });
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
    const counterStationId = this.getOperationCounterStationId(operation);
    const shouldApplyCounter =
      operation.stationCounter != null && counterStationId === station.id;

    const updatedStation = await tx.station.update({
      where: { id: station.id },
      data: {
        currentStock: { increment: movementQuantity },
        ...(shouldApplyCounter
          ? {
              currentCounter: Number(operation.stationCounter),
              currentLifetimeCounter:
                operation.lifetimeCounter == null
                  ? this.calculateStationLifetimeSnapshot(
                      station,
                      Number(operation.stationCounter),
                    ).lifetimeCounter
                  : Number(operation.lifetimeCounter),
              currentCounterCycle:
                operation.stationCounterCycleNumber == null
                  ? Number(station.currentCounterCycle || 1)
                  : Number(operation.stationCounterCycleNumber),
            }
          : {}),
      },
      select: {
        currentStock: true,
      },
    });

    const balanceAfter = Number(updatedStation.currentStock || 0);
    const balanceBefore = balanceAfter - movementQuantity;

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

    const counterStation =
      type === 'DIRECT_REFUEL'
        ? entities.sourceStation
        : type === 'INTERNAL_TRANSFER' ||
            type === 'EXTERNAL_SUPPLY' ||
            type === 'EXTERNAL_TRANSFER'
          ? entities.destinationStation
          : null;

    if (
      counterStation &&
      dto.stationCounter !== undefined &&
      dto.stationCounter !== null
    ) {
      Object.assign(
        snapshot,
        this.calculateStationLifetimeSnapshot(
          counterStation,
          Number(dto.stationCounter),
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
    if (operation.type === 'DIRECT_REFUEL') return operation.sourceStationId || null;
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
      entities.sourceStation?.project?.name ||
      entities.sourceStation?.project?.code ||
      null;

    const destinationProjectId = entities.destinationProjectId || null;
    const destinationProjectName =
      entities.destinationStation?.project?.name ||
      entities.destinationStation?.project?.code ||
      null;

    const assetProjectId = entities.assetProjectId || null;
    const assetProjectName =
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
      this.require(dto.invoiceNumber, 'invoiceNumber is required for External Supply.');
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
