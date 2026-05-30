import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StationsService {
  constructor(private prisma: PrismaService) {}

  private normalizeStationId(stationId: string) {
    return String(stationId || '').trim().toUpperCase();
  }

  private mapStationStatus(status?: string) {
    const normalized = String(status || 'ACTIVE')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');

    if (normalized === 'INACTIVE') return 'INACTIVE';
    return 'ACTIVE';
  }

  private parseOptionalDate(value?: string, fallback = new Date()) {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Invalid date');
    }
    return date;
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

  async findAll(companyId?: string, projectId?: string) {
    return this.prisma.station.findMany({
      where: {
        deletedAt: null,
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

    const openingBalance = Number(body.openingBalance || 0);
    if (!Number.isFinite(openingBalance)) {
      throw new BadRequestException('Opening balance must be a valid number');
    }

    const currentCounter = Number(body.currentCounter || 0);
    if (!Number.isFinite(currentCounter) || currentCounter < 0) {
      throw new BadRequestException('Station counter must be a valid positive number');
    }

    return this.prisma.$transaction(async (tx) => {
      const createdStation = await tx.station.create({
        data: {
          companyId: body.companyId,
          stationId,
          name: body.name?.trim() || null,
          type: body.type?.trim() || null,
          capacity:
            body.capacity === undefined || body.capacity === null
              ? null
              : Number(body.capacity),
          openingBalance,
          currentStock: openingBalance,
          currentCounter,
          projectId: body.projectId || null,
          status: this.mapStationStatus(body.status) as any,
          createdById: body.createdById || null,
        },
        include: {
          company: true,
          project: true,
        },
      });

      await tx.stationStockMovement.create({
        data: {
          companyId: body.companyId,
          stationId: createdStation.id,
          movementType: 'OPENING_BALANCE' as any,
          quantity: openingBalance,
          balanceBefore: 0,
          balanceAfter: openingBalance,
          referenceType: 'STATION_CREATE',
          referenceId: createdStation.id,
          reason: 'Initial station opening balance',
          createdByUserId: body.createdById || null,
        },
      });

      if (body.projectId) {
        await tx.stationAssignmentHistory.create({
          data: {
            companyId: body.companyId,
            stationId: createdStation.id,
            fromProjectId: null,
            toProjectId: body.projectId,
            transferRequestId: null,
            assignmentType: 'INITIAL_ASSIGNMENT' as any,
            reason: 'Initial station project assignment',
            assignedAt: new Date(),
            assignedByUserId: body.createdById || null,
          },
        });
      }

      return createdStation;
    });
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
    });

    if (!station) {
      throw new NotFoundException('Station not found');
    }

    const newCounter = Number(body.newCounter);
    if (!Number.isFinite(newCounter) || newCounter < 0) {
      throw new BadRequestException('New counter must be a valid positive number');
    }

    if (!body.reason?.trim()) {
      throw new BadRequestException('Reset reason is required');
    }

    const effectiveAt = this.parseOptionalDate(body.effectiveAt);

    return this.prisma.$transaction(async (tx) => {
      const resetRecord = await tx.stationCounterReset.create({
        data: {
          stationId: station.id,
          companyId: station.companyId,
          oldCounter: Number(station.currentCounter || 0),
          newCounter,
          reason: body.reason.trim(),
          effectiveAt,
          createdByUserId: body.createdByUserId || null,
        },
      });

      const updatedStation = await tx.station.update({
        where: {
          id: station.id,
        },
        data: {
          currentCounter: newCounter,
        },
        include: {
          company: true,
          project: true,
        },
      });

      return {
        station: updatedStation,
        resetRecord,
      };
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

    const movementAt = this.parseOptionalDate(body.movementAt);

    return this.prisma.$transaction(async (tx) => {
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
    });
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

    const movementAt = this.parseOptionalDate(body.movementAt);

    return this.prisma.$transaction(async (tx) => {
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
    });
  }

  async createTransferRequest(
    stationId: string,
    toProjectId: string,
    requestedByUserId: string,
  ) {
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

    const approvers = [
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
    ].filter(
      (item, index, list) =>
        // If the same manager is responsible for both source and destination projects,
        // one approval is enough.
        list.findIndex(
          (candidate) =>
            candidate.approverUserId === item.approverUserId,
        ) === index,
    );

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
    });
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

    const pendingApproval = request.approvals.find(
      (approval) =>
        approval.approverUserId === managerUserId &&
        approval.status === 'PENDING',
    );

    if (!pendingApproval) {
      throw new BadRequestException('User cannot approve this station transfer');
    }

    if (!approve) {
      return this.prisma.$transaction(async (tx) => {
        await tx.stationTransferApproval.update({
          where: {
            id: pendingApproval.id,
          },
          data: {
            status: 'REJECTED',
            note: rejectionReason || 'Rejected',
            reviewedAt: new Date(),
          },
        });

        return tx.stationTransferRequest.update({
          where: {
            id: transferId,
          },
          data: {
            status: 'REJECTED',
            rejectedAt: new Date(),
            rejectionReason: rejectionReason || 'Rejected',
          },
          include: {
            station: true,
            fromProject: true,
            toProject: true,
            approvals: true,
          },
        });
      });
    }

    return this.prisma.$transaction(async (tx) => {
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
          assignedAt: new Date(),
          assignedByUserId: managerUserId,
        },
      });

      return tx.stationTransferRequest.update({
        where: {
          id: transferId,
        },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          appliedAt: new Date(),
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
    });
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
