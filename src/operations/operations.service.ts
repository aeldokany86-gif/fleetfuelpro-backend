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

@Injectable()
export class OperationsService {
  constructor(private readonly prisma: PrismaService) {}

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
      {
        type: 'DIRECT_REFUEL' as any,
        quantity: 1,
      } as CreateOperationDto,
      request,
    );

    if (!currentUser.existsInDatabase) {
      throw new UnauthorizedException(
        'Real database user is required to review operation approvals.',
      );
    }

    if (currentUser.role !== 'Manager') {
      throw new ForbiddenException('Only project managers can review operation approvals.');
    }

    const action = String(dto.action || '').toUpperCase();

    if (!['APPROVE', 'REJECT'].includes(action)) {
      throw new BadRequestException('Review action must be APPROVE or REJECT.');
    }

    /*
      Keep reads and validation outside the interactive transaction.
      The old review() loaded the operation, approvals, entities, then updated stock
      all inside one transaction. On Supabase pooler this sometimes exceeded the
      5s Prisma interactive transaction window and caused P2028.
    */
    const operation = await (this.prisma as any).operation.findUnique({
      where: { id: operationId },
      include: {
        approvals: true,
      },
    });

    if (!operation) {
      throw new NotFoundException('Operation was not found.');
    }

    if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(operation.status)) {
      throw new BadRequestException(
        `Operation cannot be reviewed because it is already ${operation.status}.`,
      );
    }

    const approval = operation.approvals.find(
      (item: any) =>
        item.approverUserId === currentUser.id && item.status === 'PENDING',
    );

    if (!approval) {
      throw new ForbiddenException(
        'You do not have a pending approval for this operation.',
      );
    }

    if (action === 'REJECT') {
      const result = await this.prisma.$transaction(async (tx) => {
        const reviewedApproval = await (tx as any).operationApproval.update({
          where: { id: approval.id },
          data: {
            status: 'REJECTED',
            note: dto.note || null,
            reviewedAt: new Date(),
          },
        });

        const rejectedOperation = await (tx as any).operation.update({
          where: { id: operation.id },
          data: {
            status: 'REJECTED',
            rejectedAt: new Date(),
          },
        });

        return {
          operation: rejectedOperation,
          reviewedApproval,
          completedNow: false,
          rejectedNow: true,
        };
      });

      return {
        ok: true,
        operationId: result.operation.id,
        operationNo: result.operation.operationNo,
        status: result.operation.status,
        completedNow: result.completedNow,
        rejectedNow: result.rejectedNow,
        reviewedBy: {
          id: currentUser.id,
          name: currentUser.fullName,
          role: currentUser.role,
        },
        message: 'Operation rejected successfully.',
      };
    }

    const allApprovedAfterThisReview = operation.approvals.every((item: any) =>
      item.id === approval.id ? true : item.status === 'APPROVED',
    );

    if (!allApprovedAfterThisReview) {
      const result = await this.prisma.$transaction(async (tx) => {
        const reviewedApproval = await (tx as any).operationApproval.update({
          where: { id: approval.id },
          data: {
            status: 'APPROVED',
            note: dto.note || null,
            reviewedAt: new Date(),
          },
        });

        const partiallyApprovedOperation = await (tx as any).operation.update({
          where: { id: operation.id },
          data: {
            status: 'PARTIALLY_APPROVED',
            approvedAt: new Date(),
          },
        });

        return {
          operation: partiallyApprovedOperation,
          reviewedApproval,
          completedNow: false,
          rejectedNow: false,
        };
      });

      return {
        ok: true,
        operationId: result.operation.id,
        operationNo: result.operation.operationNo,
        status: result.operation.status,
        completedNow: result.completedNow,
        rejectedNow: result.rejectedNow,
        reviewedBy: {
          id: currentUser.id,
          name: currentUser.fullName,
          role: currentUser.role,
        },
        message: 'Operation approved and pending remaining project manager approval.',
      };
    }

    const operationDto = {
      type: operation.type,
      sourceStationId: operation.sourceStationId || undefined,
      destinationStationId: operation.destinationStationId || undefined,
      assetId: operation.assetId || undefined,
      quantity: Number(operation.quantity),
      odometer:
        operation.odometer === null || operation.odometer === undefined
          ? undefined
          : Number(operation.odometer),
      stationCounter:
        operation.stationCounter === null || operation.stationCounter === undefined
          ? undefined
          : Number(operation.stationCounter),
      externalStationName: operation.externalStationName || undefined,
      invoiceNumber: operation.invoiceNumber || undefined,
      notes: operation.notes || undefined,
      companyId: operation.companyId,
    } as CreateOperationDto;

    /*
      Load and validate entities before opening the write transaction.
      The transaction below now only performs writes.
    */
    const entities = await this.loadAndValidateEntities(
      this.prisma as any,
      operationDto,
      currentUser,
      operation.type,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      const reviewedApproval = await (tx as any).operationApproval.update({
        where: { id: approval.id },
        data: {
          status: 'APPROVED',
          note: dto.note || null,
          reviewedAt: new Date(),
        },
      });

      const completedOperation = await (tx as any).operation.update({
        where: { id: operation.id },
        data: {
          status: 'COMPLETED',
          approvedAt: new Date(),
          completedAt: new Date(),
        },
      });

      await this.applyCompletedOperationEffects(tx, {
        operation: completedOperation,
        dto: operationDto,
        type: operation.type,
        currentUser,
        entities,
      });

      return {
        operation: completedOperation,
        reviewedApproval,
        completedNow: true,
        rejectedNow: false,
      };
    });

    return {
      ok: true,
      operationId: result.operation.id,
      operationNo: result.operation.operationNo,
      status: result.operation.status,
      completedNow: result.completedNow,
      rejectedNow: result.rejectedNow,
      reviewedBy: {
        id: currentUser.id,
        name: currentUser.fullName,
        role: currentUser.role,
      },
      message: 'Operation approved and completed successfully.',
    };
  }

async findAll(request?: RequestLike) {
  const currentUser = await this.resolveCurrentUser(
    {
      type: 'DIRECT_REFUEL' as any,
      quantity: 1,
    } as CreateOperationDto,
    request,
  );

  if (!currentUser.existsInDatabase) {
    throw new UnauthorizedException(
      'Real database user is required.',
    );
  }

  return (this.prisma as any).operation.findMany({
    where: {
      companyId: currentUser.companyId,
    },

    include: {
      requestedBy: {
        select: {
          id: true,
          fullName: true,
        },
      },

      approvals: {
        include: {
          approver: {
            select: {
              id: true,
              fullName: true,
            },
          },
        },
      },

      sourceStation: true,
      destinationStation: true,
      asset: true,
      fuelPriceHistory: true,
    },

    orderBy: {
      createdAt: 'desc',
    },
  });
}

async findPendingApprovals(request?: RequestLike) {
  const currentUser = await this.resolveCurrentUser(
    {
      type: 'DIRECT_REFUEL' as any,
      quantity: 1,
    } as CreateOperationDto,
    request,
  );

  if (!currentUser.existsInDatabase) {
    throw new UnauthorizedException(
      'Real database user is required.',
    );
  }

  return (this.prisma as any).operation.findMany({
    where: {
      companyId: currentUser.companyId,

      approvals: {
        some: {
          approverUserId: currentUser.id,
          status: 'PENDING',
        },
      },
    },

    include: {
      requestedBy: {
        select: {
          id: true,
          fullName: true,
        },
      },

      approvals: {
        include: {
          approver: {
            select: {
              id: true,
              fullName: true,
            },
          },
        },
      },

      sourceStation: true,
      destinationStation: true,
      asset: true,
      fuelPriceHistory: true,
    },

    orderBy: {
      createdAt: 'desc',
    },
  });
}

  private async createPersistedOperation(
    dto: CreateOperationDto,
    currentUser: CurrentUserContext,
    type: NormalizedOperationType,
  ) {
    /*
      Keep operation number generation outside the interactive transaction.
      On Supabase pooler, running count() inside a long transaction can close the
      transaction early and trigger Prisma P2028: "Transaction not found".
    */
    const operationNo = await this.generateOperationNo(
      this.prisma as any,
      currentUser.companyId!,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      const entities = await this.loadAndValidateEntities(tx, dto, currentUser, type);
      const approvalPlan = await this.buildApprovalPlan(tx, currentUser, type, entities);
      const status = this.getInitialOperationStatus(type, currentUser, approvalPlan);
      const completedAt = status === 'COMPLETED' ? new Date() : null;
      const costSnapshot = await this.resolveOperationCostSnapshot(tx, {
        type,
        entities,
        quantity: Number(dto.quantity),
        operationDate: new Date(),
        externalInvoiceAmount: dto.externalInvoiceAmount,
      });

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
          odometer:
            dto.odometer === undefined || dto.odometer === null
              ? null
              : Number(dto.odometer),
          stationCounter:
            dto.stationCounter === undefined || dto.stationCounter === null
              ? null
              : Number(dto.stationCounter),
          externalStationName: dto.externalStationName || null,
          invoiceNumber: dto.invoiceNumber || null,
          notes: dto.notes || null,
          attachments: dto.attachments || undefined,
          fuelPriceHistoryId: costSnapshot.fuelPriceHistoryId,
          pricePerLiterAtOperation: costSnapshot.pricePerLiterAtOperation,
          totalCostAtOperation: costSnapshot.totalCostAtOperation,
          requestedByUserId: currentUser.id,
          completedAt,
          approvedAt:
            status === 'COMPLETED' || status === 'PARTIALLY_APPROVED'
              ? new Date()
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

      return {
        operation,
        status,
        approvalPlan,
      };
    });

    return {
      ok: true,
      message: this.getPersistedSuccessMessage(type, result.status),
      operationId: result.operation.id,
      operationNo: result.operation.operationNo,
      operationType: type,
      status: result.status,
      requiresApproval: result.approvalPlan.some((item) => item.status === 'PENDING'),
      createdBy: {
        id: currentUser.id,
        name: currentUser.fullName,
        role: currentUser.role,
      },
      approvals: result.approvalPlan,
    };
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

    const userId =
      requestUser?.id ||
      this.getHeader(request, 'x-user-id') ||
      dto.requestedByUserId;

    const fallbackRole =
      requestUser?.roleName ||
      requestUser?.role ||
      requestUser?.systemRole ||
      this.getHeader(request, 'x-user-role') ||
      dto.requestedByRole;

    const fallbackName =
      requestUser?.fullName ||
      requestUser?.name ||
      requestUser?.email ||
      this.getHeader(request, 'x-user-name') ||
      dto.requestedByName;

    if (!userId || !fallbackRole) {
      throw new UnauthorizedException(
        'Current user was not found. Connect AuthGuard or send temporary x-user-id and x-user-role headers for local testing.',
      );
    }

    const dbUser = await (this.prisma as any).user
      .findUnique({
        where: { id: userId },
        include: { role: true },
      })
      .catch(() => null);

    if (dbUser) {
      return {
        id: dbUser.id,
        fullName: dbUser.fullName || dbUser.email || fallbackName || 'User',
        role: this.normalizeRole(dbUser.role?.name || fallbackRole),
        companyId: dbUser.companyId,
        existsInDatabase: true,
      };
    }

    return {
      id: userId,
      fullName: fallbackName || 'Testing User',
      role: this.normalizeRole(fallbackRole),
      companyId: dto.companyId,
      existsInDatabase: false,
    };
  }

  private async loadAndValidateEntities(
    tx: any,
    dto: CreateOperationDto,
    user: CurrentUserContext,
    type: NormalizedOperationType,
  ): Promise<LoadedOperationEntities> {
    const entities: LoadedOperationEntities = {};

    if (!user.companyId) {
      throw new BadRequestException('User companyId is required.');
    }

    if (dto.sourceStationId) {
      entities.sourceStation = await tx.station.findFirst({
        where: {
          id: dto.sourceStationId,
          companyId: user.companyId,
          deletedAt: null,
        },
        include: { project: true },
      });

      if (!entities.sourceStation) {
        throw new NotFoundException('Source station was not found.');
      }

      entities.sourceProjectId = entities.sourceStation.projectId || null;
    }

    if (dto.destinationStationId) {
      entities.destinationStation = await tx.station.findFirst({
        where: {
          id: dto.destinationStationId,
          companyId: user.companyId,
          deletedAt: null,
        },
        include: { project: true },
      });

      if (!entities.destinationStation) {
        throw new NotFoundException('Destination station was not found.');
      }

      entities.destinationProjectId = entities.destinationStation.projectId || null;
    }

    if (dto.assetId) {
      entities.asset = await tx.asset.findFirst({
        where: {
          id: dto.assetId,
          companyId: user.companyId,
          deletedAt: null,
        },
        include: { project: true },
      });

      if (!entities.asset) {
        throw new NotFoundException('Asset was not found.');
      }

      entities.assetProjectId = entities.asset.projectId || null;
    }

    this.validateProjectRules(type, entities);

    return entities;
  }

  private validateProjectRules(
    type: NormalizedOperationType,
    entities: LoadedOperationEntities,
  ) {
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

      const sourceManagerId = await this.getProjectManagerId(tx, sourceProjectId);
      const destinationManagerId = await this.getProjectManagerId(
        tx,
        destinationProjectId,
      );

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

      await this.updateAssetOdometerIfNeeded(tx, entities.asset, dto.odometer);
      return;
    }

    if (type === 'EXTERNAL_DIRECT_REFUEL') {
      await this.updateAssetOdometerIfNeeded(tx, entities.asset, dto.odometer);
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

    if (!station) {
      throw new BadRequestException('Station is required for stock movement.');
    }

    const balanceBefore = Number(station.currentStock || 0);
    const balanceAfter = balanceBefore + quantity;

    await tx.station.update({
      where: { id: station.id },
      data: {
        currentStock: balanceAfter,
        currentCounter:
          operation.stationCounter === undefined || operation.stationCounter === null
            ? station.currentCounter
            : Number(operation.stationCounter),
      },
    });

    await tx.stationStockMovement.create({
      data: {
        stationId: station.id,
        companyId: currentUser.companyId,
        movementType,
        quantity,
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
  ) {
    if (!asset || odometer === undefined || odometer === null) return;

    if (Number(odometer) < Number(asset.currentOdometer || 0)) {
      throw new BadRequestException(
        'New odometer/hour meter cannot be lower than current asset odometer.',
      );
    }

    await tx.asset.update({
      where: { id: asset.id },
      data: { currentOdometer: Number(odometer) },
    });
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
      };
    }

    const projectId = this.getOperationProjectIdForCost(args.type, args.entities);

    if (!projectId) {
      return {
        fuelPriceHistoryId: null,
        pricePerLiterAtOperation: null,
        totalCostAtOperation: null,
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

      return {
        fuelPriceHistoryId: effectivePrice.id,
        pricePerLiterAtOperation,
        totalCostAtOperation,
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
      };
    }

    return {
      fuelPriceHistoryId: null,
      pricePerLiterAtOperation: null,
      totalCostAtOperation: null,
    };
  }

  private async generateOperationNo(tx: any, companyId: string) {
    const count = await tx.operation.count({
      where: { companyId },
    });

    const next = count + 1;
    return `OP-${String(next).padStart(6, '0')}`;
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
