import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AssetsService {
  constructor(private prisma: PrismaService) {}

  private normalizeAssetId(assetId: string) {
    return String(assetId || '').trim();
  }

  private mapAssetStatus(status?: string) {
    const normalized = String(status || 'ACTIVE')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');

    if (normalized === 'INACTIVE') return 'INACTIVE';
    return 'ACTIVE';
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
    return this.prisma.asset.findMany({
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
    const asset = await this.prisma.asset.findFirst({
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
        odometerResetHistory: {
          orderBy: {
            createdAt: 'desc',
          },
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

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return asset;
  }

  async create(body: {
    companyId: string;
    assetId: string;
    type: string;
    category?: string;
    fuelTankCapacity?: number;
    currentOdometer?: number;
    projectId?: string;
    status?: string;
    createdById?: string;
  }) {
    await this.ensureCompany(body.companyId);

    const assetId = this.normalizeAssetId(body.assetId);
    if (!assetId) {
      throw new BadRequestException('Asset ID is required');
    }

    if (!body.type?.trim()) {
      throw new BadRequestException('Asset type is required');
    }

    if (body.projectId) {
      await this.ensureProject(body.projectId, body.companyId);
    }

    const duplicate = await this.prisma.asset.findFirst({
      where: {
        companyId: body.companyId,
        assetId,
      },
    });

    if (duplicate) {
      if (duplicate.deletedAt) {
        throw new BadRequestException(
          'This Asset ID was previously used and cannot be reused',
        );
      }

      throw new BadRequestException(
        'Asset ID already exists in this company',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const createdAsset = await tx.asset.create({
        data: {
          companyId: body.companyId,
          assetId,
          type: body.type.trim(),
          category: body.category?.trim() || null,
          fuelTankCapacity:
            body.fuelTankCapacity === undefined || body.fuelTankCapacity === null
              ? null
              : Number(body.fuelTankCapacity),
          currentOdometer:
            body.currentOdometer === undefined || body.currentOdometer === null
              ? 0
              : Number(body.currentOdometer),
          projectId: body.projectId || null,
          status: this.mapAssetStatus(body.status) as any,
          createdById: body.createdById || null,
        },
        include: {
          company: true,
          project: true,
        },
      });

      if (body.projectId) {
        await tx.assetAssignmentHistory.create({
          data: {
            companyId: body.companyId,
            assetId: createdAsset.id,
            fromProjectId: null,
            toProjectId: body.projectId,
            transferRequestId: null,
            assignmentType: 'INITIAL_ASSIGNMENT' as any,
            reason: 'Initial asset project assignment',
            assignedAt: new Date(),
            assignedByUserId: body.createdById || null,
          },
        });
      }

      return createdAsset;
    });
  }

  async update(
    id: string,
    body: {
      assetId?: string;
      type?: string;
      category?: string | null;
      fuelTankCapacity?: number | null;
      status?: string;
      projectId?: never;
      currentOdometer?: never;
    },
  ) {
    const existingAsset = await this.prisma.asset.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!existingAsset) {
      throw new NotFoundException('Asset not found');
    }

    const nextAssetId =
      body.assetId !== undefined
        ? this.normalizeAssetId(body.assetId)
        : existingAsset.assetId;

    if (!nextAssetId) {
      throw new BadRequestException('Asset ID is required');
    }

    if (nextAssetId !== existingAsset.assetId) {
      const duplicate = await this.prisma.asset.findFirst({
        where: {
          companyId: existingAsset.companyId,
          assetId: nextAssetId,
          NOT: {
            id,
          },
        },
      });

      if (duplicate) {
        if (duplicate.deletedAt) {
          throw new BadRequestException(
            'This Asset ID was previously used and cannot be reused',
          );
        }

        throw new BadRequestException(
          'Asset ID already exists in this company',
        );
      }
    }

    // Important:
    // Asset movement must be handled only through createTransferRequest().
    // Asset page "Odometer Reset" must be handled only through resetOdometer().
    // This update method intentionally rejects projectId/currentOdometer changes.
    if (Object.prototype.hasOwnProperty.call(body as any, 'projectId')) {
      throw new BadRequestException(
        'Asset project cannot be changed from edit. Use asset transfer workflow.',
      );
    }

    if (Object.prototype.hasOwnProperty.call(body as any, 'currentOdometer')) {
      throw new BadRequestException(
        'Asset odometer cannot be corrected from edit. Use odometer reset workflow.',
      );
    }

    return this.prisma.asset.update({
      where: {
        id,
      },
      data: {
        ...(body.assetId !== undefined ? { assetId: nextAssetId } : {}),
        ...(body.type !== undefined ? { type: body.type.trim() } : {}),
        ...(body.category !== undefined
          ? { category: body.category?.trim() || null }
          : {}),
        ...(body.fuelTankCapacity !== undefined
          ? {
              fuelTankCapacity:
                body.fuelTankCapacity === null
                  ? null
                  : Number(body.fuelTankCapacity),
            }
          : {}),
        ...(body.status !== undefined
          ? { status: this.mapAssetStatus(body.status) as any }
          : {}),
      },
      include: {
        company: true,
        project: true,
      },
    });
  }

  async resetOdometer(
    id: string,
    body: {
      newOdometer: number;
      reason: string;
      effectiveAt?: string;
      createdByUserId?: string;
    },
  ) {
    const asset = await this.prisma.asset.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    const newOdometer = Number(body.newOdometer);
    if (!Number.isFinite(newOdometer) || newOdometer < 0) {
      throw new BadRequestException('New odometer must be a valid positive number');
    }

    if (!body.reason?.trim()) {
      throw new BadRequestException('Reset reason is required');
    }

    const effectiveAt = body.effectiveAt
      ? new Date(body.effectiveAt)
      : new Date();

    if (Number.isNaN(effectiveAt.getTime())) {
      throw new BadRequestException('Invalid effective date');
    }

    return this.prisma.$transaction(async (tx) => {
      const resetRecord = await tx.assetOdometerReset.create({
        data: {
          assetId: asset.id,
          companyId: asset.companyId,
          oldOdometer: Number(asset.currentOdometer || 0),
          newOdometer,
          reason: body.reason.trim(),
          effectiveAt,
          createdByUserId: body.createdByUserId || null,
        },
      });

      const updatedAsset = await tx.asset.update({
        where: {
          id: asset.id,
        },
        data: {
          currentOdometer: newOdometer,
        },
        include: {
          company: true,
          project: true,
        },
      });

      return {
        asset: updatedAsset,
        resetRecord,
      };
    });
  }

  async getOdometerResetHistory(assetId: string) {
    const asset = await this.prisma.asset.findFirst({
      where: {
        id: assetId,
        deletedAt: null,
      },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return this.prisma.assetOdometerReset.findMany({
      where: {
        assetId,
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

  async getAssignmentHistory(assetId: string) {
    const asset = await this.prisma.asset.findFirst({
      where: {
        id: assetId,
        deletedAt: null,
      },
      select: {
        id: true,
      },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return this.prisma.assetAssignmentHistory.findMany({
      where: {
        assetId,
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
        transferRequest: {
          select: {
            id: true,
            status: true,
            fromProjectId: true,
            toProjectId: true,
            requestedByUserId: true,
            approvedAt: true,
            appliedAt: true,
            createdAt: true,
          },
        },
      },
    });
  }

  async createTransferRequest(
    assetId: string,
    toProjectId: string,
    requestedByUserId: string,
  ) {
    const asset = await this.prisma.asset.findFirst({
      where: {
        id: assetId,
        deletedAt: null,
      },
      include: {
        project: true,
      },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    if (!asset.projectId) {
      throw new BadRequestException('Asset has no current project');
    }

    if (asset.projectId === toProjectId) {
      throw new BadRequestException('Asset already belongs to this project');
    }

    const targetProject = await this.prisma.project.findFirst({
      where: {
        id: toProjectId,
        deletedAt: null,
        isActive: true,
        companyId: asset.companyId,
      },
    });

    if (!targetProject) {
      throw new BadRequestException('Target project is invalid');
    }

    if (!asset.project?.projectManagerId || !targetProject.projectManagerId) {
      throw new BadRequestException(
        'Asset transfer requires source and destination project managers',
      );
    }

    const pending = await this.prisma.assetTransferRequest.findFirst({
      where: {
        assetId,
        status: {
          in: ['PENDING', 'PARTIALLY_APPROVED'],
        },
      },
    });

    if (pending) {
      throw new BadRequestException('Pending transfer already exists');
    }

    const approvers = [
      {
        approverUserId: asset.project.projectManagerId,
        projectId: asset.projectId,
        approvalStage: 'Source Project Manager',
      },
      {
        approverUserId: targetProject.projectManagerId,
        projectId: targetProject.id,
        approvalStage: 'Destination Project Manager',
      },
    ].filter(
      (item, index, list) =>
        list.findIndex(
          (candidate) =>
            candidate.approverUserId === item.approverUserId &&
            candidate.projectId === item.projectId,
        ) === index,
    );

    return this.prisma.assetTransferRequest.create({
      data: {
        companyId: asset.companyId,
        assetId: asset.id,
        fromProjectId: asset.projectId,
        toProjectId,
        requestedByUserId,
        status: 'PENDING',
        approvals: {
          create: approvers.map((approver) => ({
            approverUserId: approver.approverUserId,
            projectId: approver.projectId,
            approvalStage: approver.approvalStage,
            status: 'PENDING',
          })),
        },
      },
      include: {
        asset: true,
        fromProject: true,
        toProject: true,
        approvals: true,
      },
    });
  }

  async getPendingTransferRequests() {
    return this.prisma.assetTransferRequest.findMany({
      where: {
        status: {
          in: ['PENDING', 'PARTIALLY_APPROVED'],
        },
      },
      include: {
        asset: true,
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
    const request = await this.prisma.assetTransferRequest.findFirst({
      where: {
        id: transferId,
      },
      include: {
        asset: true,
        fromProject: true,
        toProject: true,
        approvals: true,
      },
    });

    if (!request) {
      throw new NotFoundException('Asset transfer request not found');
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
      throw new BadRequestException('User cannot approve this asset transfer');
    }

    if (!approve) {
      return this.prisma.$transaction(async (tx) => {
        await tx.assetTransferApproval.update({
          where: {
            id: pendingApproval.id,
          },
          data: {
            status: 'REJECTED',
            note: rejectionReason || 'Rejected',
            reviewedAt: new Date(),
          },
        });

        return tx.assetTransferRequest.update({
          where: {
            id: transferId,
          },
          data: {
            status: 'REJECTED',
            rejectedAt: new Date(),
            rejectionReason: rejectionReason || 'Rejected',
          },
          include: {
            asset: true,
            fromProject: true,
            toProject: true,
            approvals: true,
          },
        });
      });
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.assetTransferApproval.update({
        where: {
          id: pendingApproval.id,
        },
        data: {
          status: 'APPROVED',
          reviewedAt: new Date(),
        },
      });

      const approvals = await tx.assetTransferApproval.findMany({
        where: {
          transferRequestId: transferId,
        },
      });

      const fullyApproved = approvals.every(
        (approval) => approval.status === 'APPROVED',
      );

      if (!fullyApproved) {
        return tx.assetTransferRequest.update({
          where: {
            id: transferId,
          },
          data: {
            status: 'PARTIALLY_APPROVED',
            reason: `First approval by manager ${managerUserId}`,
          },
          include: {
            asset: true,
            fromProject: true,
            toProject: true,
            approvals: true,
          },
        });
      }

      await tx.asset.update({
        where: {
          id: request.assetId,
        },
        data: {
          projectId: request.toProjectId,
        },
      });

      await tx.assetAssignmentHistory.create({
        data: {
          companyId: request.companyId,
          assetId: request.assetId,
          fromProjectId: request.fromProjectId,
          toProjectId: request.toProjectId,
          transferRequestId: request.id,
          assignmentType: 'TRANSFER' as any,
          reason: 'Asset transfer approved and applied',
          assignedAt: new Date(),
          assignedByUserId: managerUserId,
        },
      });

      return tx.assetTransferRequest.update({
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
          asset: true,
          fromProject: true,
          toProject: true,
          approvals: true,
        },
      });
    });
  }

  async remove(id: string) {
    const asset = await this.prisma.asset.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return this.prisma.asset.update({
      where: {
        id,
      },
      data: {
        deletedAt: new Date(),
      },
    });
  }
}
