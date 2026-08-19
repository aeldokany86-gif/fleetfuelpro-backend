import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { randomUUID } from 'crypto';

import { PrismaService } from '../prisma/prisma.service';
import { AssetCreationDomainService } from './asset-creation-domain.service';

@Injectable()
export class AssetsService {
  constructor(
    private prisma: PrismaService,
    private readonly assetCreationDomainService: AssetCreationDomainService,
  ) {}

  private normalizeAssetId(assetId: string) {
    return this.assetCreationDomainService.normalizeAssetId(assetId);
  }

  private mapAssetStatus(status?: string) {
    return this.assetCreationDomainService.mapAssetStatus(status);
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

  private async getRequester(
    requestedByUserId: string,
    companyId: string,
  ) {
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


  private async ensureAssetOdometerDirectPermission(
    asset: any,
    userId: string | undefined,
  ) {
    if (!userId) {
      throw new BadRequestException('Actor user is required');
    }

    const actor = await this.getRequester(userId, asset.companyId);
    const roleName = actor.role?.name || '';

    if (this.isAdminRole(roleName)) {
      return actor;
    }

    if (!this.isManagerRole(roleName)) {
      throw new BadRequestException(
        'Only the assigned Project Manager or Admin can reset an asset odometer directly',
      );
    }

    const projectManagerId =
      asset.project?.projectManagerId ||
      (asset.projectId
        ? (
            await this.prisma.project.findFirst({
              where: {
                id: asset.projectId,
                companyId: asset.companyId,
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
        'Only the assigned Project Manager can reset this asset odometer directly',
      );
    }

    return actor;
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
    const assetId = this.normalizeAssetId(body.assetId);

    if (!assetId) {
      throw new BadRequestException('Asset ID is required');
    }

    if (!body.type?.trim()) {
      throw new BadRequestException('Asset type is required');
    }

    // ✅ OPTIMIZATION: كل الـ validation queries بتشتغل بالتوازي بدل ما تشتغل واحدة ورا التانية
    // الأصل: 3 queries × ~500ms = ~1500ms
    // بعد التعديل: 3 queries معاً = ~500ms فقط
    const [company, project, duplicate] = await Promise.all([
      this.ensureCompany(body.companyId),
      this.ensureProject(body.projectId ?? null, body.companyId),
      this.prisma.asset.findMany({
        where: {
          companyId: body.companyId,
        },
        select: {
          id: true,
          assetId: true,
          deletedAt: true,
        },
      }),
    ]);

    // company و project اتتحققوا جوه ensureCompany/ensureProject
    // بس TypeScript محتاج يعرف إنهم موجودين
    void company;
    void project;

    const duplicateAsset = duplicate.find(
      (item) => this.normalizeAssetId(item.assetId) === assetId,
    );

    if (duplicateAsset) {
      if (duplicateAsset.deletedAt) {
        throw new BadRequestException(
          'This Asset ID was previously used and cannot be reused',
        );
      }

      throw new BadRequestException(
        'Asset ID already exists in this company',
      );
    }

    return this.assetCreationDomainService.createAsset(this.prisma as any, {
      companyId: body.companyId,
      assetId,
      type: body.type,
      category: body.category,
      fuelTankCapacity: body.fuelTankCapacity,
      currentOdometer: body.currentOdometer,
      projectId: body.projectId || null,
      status: body.status,
      createdById: body.createdById || null,
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

    if (
      nextAssetId !== this.normalizeAssetId(existingAsset.assetId)
    ) {
      const companyAssets = await this.prisma.asset.findMany({
        where: {
          companyId: existingAsset.companyId,
          NOT: { id },
        },
        select: {
          id: true,
          assetId: true,
          deletedAt: true,
        },
      });

      const duplicateAsset = companyAssets.find(
        (item) => this.normalizeAssetId(item.assetId) === nextAssetId,
      );

      if (duplicateAsset) {
        if (duplicateAsset.deletedAt) {
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
      where: { id },
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
        // ✅ OPTIMIZATION: select بدل include الكامل — بيجيب الـ fields المطلوبة بس
        company: {
          select: { id: true, name: true, code: true },
        },
        project: {
          select: { id: true, code: true, name: true, projectManagerId: true },
        },
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
    const newOdometer = Number(body.newOdometer);

    if (!Number.isFinite(newOdometer) || newOdometer < 0) {
      throw new BadRequestException(
        'New odometer must be a valid non-negative number',
      );
    }

    if (!body.reason?.trim()) {
      throw new BadRequestException('Reset reason is required');
    }

    const now = new Date();
    const rawEffectiveAt = String(body.effectiveAt || '').trim();
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(rawEffectiveAt);

    let effectiveAt = rawEffectiveAt ? new Date(rawEffectiveAt) : now;

    if (Number.isNaN(effectiveAt.getTime())) {
      throw new BadRequestException('Invalid effective date');
    }

    /*
      The frontend date input sends YYYY-MM-DD without a clock time.
      When the selected date is today, treat the reset as happening now,
      otherwise JavaScript would parse it at midnight and incorrectly make
      a normal operational reset look historical.
    */
    if (isDateOnly) {
      const todayUtc = now.toISOString().slice(0, 10);

      if (rawEffectiveAt === todayUtc) {
        effectiveAt = now;
      }
    }

    /*
      Load validation data before opening the interactive transaction.
      The transaction below is write-only and contains only:
      1) reset history creation
      2) asset current-state update

      A normal reset must never rebuild or rewrite historical operations.
    */
    const [asset, latestCompletedOperation] = await Promise.all([
      this.prisma.asset.findFirst({
        where: {
          id,
          deletedAt: null,
        },
        select: {
          id: true,
          companyId: true,
          projectId: true,
          createdAt: true,
          currentOdometer: true,
          currentLifetimeOdometer: true,
          currentMeterCycle: true,
          project: {
            select: {
              id: true,
              projectManagerId: true,
            },
          },
        },
      }),
      this.prisma.operation.findFirst({
        where: {
          assetId: id,
          status: 'COMPLETED',
          odometer: { not: null },
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          operationNo: true,
          occurredAt: true,
          createdAt: true,
        },
      }),
    ]);

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    await this.ensureAssetOdometerDirectPermission(
      asset,
      body.createdByUserId,
    );

    if (effectiveAt.getTime() < asset.createdAt.getTime()) {
      throw new BadRequestException(
        'Reset effective date cannot be before the asset creation date',
      );
    }

    if (effectiveAt.getTime() > now.getTime()) {
      throw new BadRequestException(
        'Reset effective date cannot be in the future',
      );
    }

    /*
      Backdated resets change the meaning of later operations and therefore
      belong to the historical-correction workflow, not the normal reset flow.
    */
    if (
      latestCompletedOperation &&
      effectiveAt.getTime() < latestCompletedOperation.occurredAt.getTime()
    ) {
      throw new BadRequestException(
        `Reset effective date cannot be earlier than the latest completed operation (${latestCompletedOperation.operationNo}). Use the historical correction workflow for a backdated reset.`,
      );
    }

    const currentLifetime = this.getEffectiveAssetLifetime(asset);
    const oldMeterCycle = Number(asset.currentMeterCycle || 1);
    const newMeterCycle = oldMeterCycle + 1;
    const oldOdometer = Number(asset.currentOdometer || 0);

    return this.prisma.$transaction(
      async (tx) => {
        const resetRecord = await tx.assetOdometerReset.create({
          data: {
            assetId: asset.id,
            companyId: asset.companyId,
            oldOdometer,
            newOdometer,
            lifetimeAtReset: currentLifetime,
            oldMeterCycle,
            newMeterCycle,
            reason: body.reason.trim(),
            effectiveAt,
            createdByUserId: body.createdByUserId || null,
          },
        });

        const updatedAsset = await tx.asset.update({
          where: { id: asset.id },
          data: {
            currentOdometer: newOdometer,
            currentLifetimeOdometer: currentLifetime,
            currentMeterCycle: newMeterCycle,
          },
          include: {
            company: {
              select: { id: true, name: true, code: true },
            },
            project: {
              select: {
                id: true,
                code: true,
                name: true,
                projectManagerId: true,
              },
            },
          },
        });

        return { asset: updatedAsset, resetRecord };
      },
      {
        maxWait: 5000,
        timeout: 10000,
      },
    );
  }


  async createActionRequest(
    assetId: string,
    body: {
      actionType: string;
      requestedByUserId: string;
      reason: string;
      newOdometer?: number;
      effectiveAt?: string;
    },
  ) {
    const actionType = String(body.actionType || '')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');

    if (actionType !== 'ODOMETER_RESET') {
      throw new BadRequestException('Unsupported asset action request type');
    }

    if (!body.requestedByUserId) {
      throw new BadRequestException('Requester user is required');
    }

    if (!body.reason?.trim()) {
      throw new BadRequestException('Request reason is required');
    }

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

    if (!asset.projectId || !asset.project) {
      throw new BadRequestException(
        'Asset must be assigned to an active project before submitting this request',
      );
    }

    const requester = await this.getRequester(
      body.requestedByUserId,
      asset.companyId,
    );

    if (!this.isOfficerRole(requester.role?.name || '')) {
      throw new BadRequestException(
        'Only Officer can submit an asset odometer reset request',
      );
    }

    if (!asset.project.projectManagerId) {
      throw new BadRequestException(
        'Asset project has no assigned Project Manager',
      );
    }

    const requestedOdometer = Number(body.newOdometer);
    if (!Number.isFinite(requestedOdometer) || requestedOdometer < 0) {
      throw new BadRequestException(
        'New odometer must be a valid non-negative number',
      );
    }

    const now = new Date();
    const rawEffectiveAt = String(body.effectiveAt || '').trim();
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(rawEffectiveAt);
    let effectiveAt = rawEffectiveAt ? new Date(rawEffectiveAt) : now;

    if (Number.isNaN(effectiveAt.getTime())) {
      throw new BadRequestException('Invalid effective date');
    }

    if (isDateOnly && rawEffectiveAt === now.toISOString().slice(0, 10)) {
      effectiveAt = now;
    }

    if (effectiveAt.getTime() < asset.createdAt.getTime()) {
      throw new BadRequestException(
        'Reset effective date cannot be before the asset creation date',
      );
    }

    if (effectiveAt.getTime() > now.getTime()) {
      throw new BadRequestException(
        'Reset effective date cannot be in the future',
      );
    }

    const latestCompletedOperation = await this.prisma.operation.findFirst({
      where: {
        assetId,
        status: 'COMPLETED',
        odometer: { not: null },
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        operationNo: true,
        occurredAt: true,
        createdAt: true,
      },
    });

    if (
      latestCompletedOperation &&
      effectiveAt.getTime() < latestCompletedOperation.occurredAt.getTime()
    ) {
      throw new BadRequestException(
        `Reset effective date cannot be earlier than the latest completed operation (${latestCompletedOperation.operationNo}). Use the historical correction workflow for a backdated reset.`,
      );
    }

    const existingPending = await this.prisma.assetActionRequest.findFirst({
      where: {
        assetId,
        status: 'PENDING',
        actionType: 'ODOMETER_RESET' as any,
      },
    });

    if (existingPending) {
      throw new BadRequestException(
        'A pending odometer reset request already exists for this asset',
      );
    }

    return this.prisma.assetActionRequest.create({
      data: {
        companyId: asset.companyId,
        assetId: asset.id,
        projectId: asset.projectId,
        requestedByUserId: body.requestedByUserId,
        actionType: 'ODOMETER_RESET' as any,
        status: 'PENDING' as any,
        reason: body.reason.trim(),
        requestedOdometer,
        effectiveAt,
      },
      include: {
        asset: {
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

    const normalizedStatus = String(status || '')
      .trim()
      .toUpperCase();

    if (
      normalizedStatus &&
      !['PENDING', 'PROCESSING', 'APPROVED', 'REJECTED'].includes(
        normalizedStatus,
      )
    ) {
      throw new BadRequestException('Invalid asset action request status');
    }

    const visibility: any[] = [
      {
        requestedByUserId: user.id,
      },
    ];

    if (this.isAdminRole(user.role?.name || '')) {
      visibility.push({
        companyId: user.companyId,
      });
    } else if (this.isManagerRole(user.role?.name || '')) {
      visibility.push({
        project: {
          is: {
            projectManagerId: user.id,
          },
        },
        actionType: 'ODOMETER_RESET' as any,
      });
    }

    return this.prisma.assetActionRequest.findMany({
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
        asset: {
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

    const request = await this.prisma.assetActionRequest.findFirst({
      where: {
        id: requestId,
      },
      include: {
        asset: {
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
      throw new NotFoundException('Asset action request not found');
    }

    if (request.status !== 'PENDING') {
      throw new BadRequestException('Asset action request already reviewed');
    }

    const reviewer = await this.getRequester(
      body.reviewerUserId,
      request.companyId,
    );

    if (!this.isManagerRole(reviewer.role?.name || '')) {
      throw new BadRequestException(
        'Only the assigned Project Manager can review this asset request',
      );
    }

    const assignedManagerId =
      request.asset?.project?.projectManagerId ||
      request.project?.projectManagerId ||
      null;

    if (!assignedManagerId || assignedManagerId !== body.reviewerUserId) {
      throw new BadRequestException(
        'Only the assigned Project Manager can review this asset request',
      );
    }

    const now = new Date();
    const reviewNote = String(body.reviewNote || '').trim();

    if (!body.approve) {
      return this.prisma.$transaction(
        async (tx) => {
          const claimed = await tx.assetActionRequest.updateMany({
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
              'Asset action request already reviewed',
            );
          }

          return tx.assetActionRequest.findUnique({
            where: {
              id: requestId,
            },
            include: {
              asset: {
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
        { maxWait: 5000, timeout: 15000 },
      );
    }

    return this.prisma.$transaction(
      async (tx) => {
        const claimed = await tx.assetActionRequest.updateMany({
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
            'Asset action request already reviewed',
          );
        }

        const asset = await tx.asset.findFirst({
          where: {
            id: request.assetId,
            deletedAt: null,
          },
        });

        if (!asset) {
          throw new NotFoundException('Asset not found');
        }

        const newOdometer = Number(request.requestedOdometer);
        if (!Number.isFinite(newOdometer) || newOdometer < 0) {
          throw new BadRequestException(
            'Requested odometer value is invalid',
          );
        }

        const effectiveAt = request.effectiveAt || now;

        if (effectiveAt.getTime() < asset.createdAt.getTime()) {
          throw new BadRequestException(
            'Reset effective date cannot be before the asset creation date',
          );
        }

        if (effectiveAt.getTime() > now.getTime()) {
          throw new BadRequestException(
            'Reset effective date cannot be in the future',
          );
        }

        const latestCompletedOperation = await tx.operation.findFirst({
          where: {
            assetId: asset.id,
            status: 'COMPLETED',
            odometer: { not: null },
          },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            operationNo: true,
            occurredAt: true,
            createdAt: true,
          },
        });

        if (
          latestCompletedOperation &&
          effectiveAt.getTime() < latestCompletedOperation.occurredAt.getTime()
        ) {
          throw new BadRequestException(
            `Reset effective date cannot be earlier than the latest completed operation (${latestCompletedOperation.operationNo}). Use the historical correction workflow for a backdated reset.`,
          );
        }

        const currentLifetime = this.getEffectiveAssetLifetime(asset);
        const oldMeterCycle = Number(asset.currentMeterCycle || 1);
        const newMeterCycle = oldMeterCycle + 1;
        const oldOdometer = Number(asset.currentOdometer || 0);

        const resetRecord = await tx.assetOdometerReset.create({
          data: {
            assetId: asset.id,
            companyId: asset.companyId,
            oldOdometer,
            newOdometer,
            lifetimeAtReset: currentLifetime,
            oldMeterCycle,
            newMeterCycle,
            reason: request.reason,
            effectiveAt,
            createdByUserId: body.reviewerUserId,
          },
        });

        const updatedAsset = await tx.asset.update({
          where: {
            id: asset.id,
          },
          data: {
            currentOdometer: newOdometer,
            currentLifetimeOdometer: currentLifetime,
            currentMeterCycle: newMeterCycle,
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
          },
        });

        const updatedRequest = await tx.assetActionRequest.update({
          where: {
            id: requestId,
          },
          data: {
            status: 'APPROVED' as any,
            approvedAt: now,
            appliedAt: now,
          },
          include: {
            asset: {
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
          result: {
            asset: updatedAsset,
            resetRecord,
          },
        };
      },
      { maxWait: 5000, timeout: 15000 },
    );
  }

  private getEffectiveAssetLifetime(asset: any) {
    const storedLifetime = Number(asset?.currentLifetimeOdometer || 0);
    const currentReading = Number(asset?.currentOdometer || 0);
    const currentCycle = Number(asset?.currentMeterCycle || 1);

    // Existing assets received the new lifetime field with a database default of 0.
    // During cycle 1, the physical reading itself is the safe initial lifetime baseline.
    if (currentCycle === 1 && storedLifetime === 0 && currentReading > 0) {
      return currentReading;
    }

    return storedLifetime;
  }

  private async rebuildAssetLifetimeHistory(tx: any, assetId: string) {
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
      throw new NotFoundException('Asset not found');
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
        orderBy: [{ effectiveAt: 'asc' }, { createdAt: 'asc' }],
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

      if (effectiveTime !== 0) {
        return effectiveTime;
      }

      const createdTime =
        new Date(a.createdAt).getTime() -
        new Date(b.createdAt).getTime();

      if (createdTime !== 0) {
        return createdTime;
      }

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

        if (lifetimeOdometer === null) {
          lifetimeOdometer = oldReading;
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

  async getOdometerHistoryReport(filters: {
    companyId?: string;
    projectId?: string;
    assetId?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const companyId = String(filters.companyId || '').trim();
    const projectId = String(filters.projectId || '').trim();
    const assetId = String(filters.assetId || '').trim();

    if (!companyId) {
      throw new BadRequestException('Company ID is required');
    }

    const parseReportDate = (
      value: string | undefined,
      fieldName: 'dateFrom' | 'dateTo',
    ) => {
      const rawValue = String(value || '').trim();
      if (!rawValue) return null;

      const parsedDate = new Date(rawValue);
      if (Number.isNaN(parsedDate.getTime())) {
        throw new BadRequestException(`Invalid ${fieldName}`);
      }

      /*
        Date-only report filters are interpreted as full UTC calendar days.
        This keeps dateTo inclusive instead of stopping at midnight.
      */
      if (/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) {
        if (fieldName === 'dateFrom') {
          parsedDate.setUTCHours(0, 0, 0, 0);
        } else {
          parsedDate.setUTCHours(23, 59, 59, 999);
        }
      }

      return parsedDate;
    };

    const dateFrom = parseReportDate(filters.dateFrom, 'dateFrom');
    const dateTo = parseReportDate(filters.dateTo, 'dateTo');

    if (dateFrom && dateTo && dateFrom.getTime() > dateTo.getTime()) {
      throw new BadRequestException(
        'Date From cannot be later than Date To',
      );
    }

    const history = await this.prisma.assetOdometerReset.findMany({
      where: {
        companyId,
        ...(assetId ? { assetId } : {}),
        ...(dateFrom || dateTo
          ? {
              effectiveAt: {
                ...(dateFrom ? { gte: dateFrom } : {}),
                ...(dateTo ? { lte: dateTo } : {}),
              },
            }
          : {}),
        asset: {
          is: {
            companyId,
            ...(projectId ? { projectId } : {}),
          },
        },
      },
      select: {
        id: true,
        assetId: true,
        companyId: true,
        oldOdometer: true,
        newOdometer: true,
        lifetimeAtReset: true,
        oldMeterCycle: true,
        newMeterCycle: true,
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
        asset: {
          select: {
            id: true,
            assetId: true,
            type: true,
            category: true,
            projectId: true,
            project: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
    });

    return history.map((record) => ({
      id: record.id,
      eventType: 'RESET',
      eventSource: 'ODOMETER_RESET',
      eventDate: record.effectiveAt,
      createdAt: record.createdAt,
      companyId: record.companyId,
      assetBackendId: record.asset.id,
      assetId: record.asset.assetId,
      assetType: record.asset.type,
      category: record.asset.category,
      projectId: record.asset.projectId,
      projectCode: record.asset.project?.code || null,
      projectName: record.asset.project?.name || null,
      previousReading: Number(record.oldOdometer || 0),
      currentReading: Number(record.newOdometer || 0),
      lifetimeReading: Number(record.lifetimeAtReset || 0),
      previousMeterCycle: Number(record.oldMeterCycle || 1),
      meterCycle: Number(record.newMeterCycle || 1),
      reason: record.reason,
      reference: record.id,
      performedByUserId: record.createdBy?.id || null,
      performedBy: record.createdBy?.fullName || null,
      performedByEmail: record.createdBy?.email || null,
    }));
  }

  // ✅ OPTIMIZATION: دمج الـ asset check مع الـ history في query واحدة
  async getOdometerResetHistory(assetId: string) {
    const asset = await this.prisma.asset.findFirst({
      where: {
        id: assetId,
        deletedAt: null,
      },
      select: {
        id: true,
        odometerResetHistory: {
          orderBy: { createdAt: 'desc' },
          include: {
            createdBy: {
              select: {
                id: true,
                fullName: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return asset.odometerResetHistory;
  }

  // ✅ OPTIMIZATION: دمج الـ asset check مع الـ history في query واحدة
  async getAssignmentHistory(assetId: string) {
    const asset = await this.prisma.asset.findFirst({
      where: {
        id: assetId,
        deletedAt: null,
      },
      select: {
        id: true,
        assignmentHistory: {
          orderBy: { assignedAt: 'desc' },
          include: {
            fromProject: {
              select: { id: true, code: true, name: true },
            },
            toProject: {
              select: { id: true, code: true, name: true },
            },
            assignedBy: {
              select: { id: true, fullName: true, email: true },
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
                effectiveDate: true,
                createdAt: true,
              },
            },
          },
        },
      },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return asset.assignmentHistory;
  }

  private async createTransferRequestCore(
    assetId: string,
    toProjectId: string,
    requestedByUserId: string,
    _effectiveDateInput?: string,
    transferBatchId?: string | null,
  ) {
    /*
      Shared source of truth for both single and bulk asset transfers.

      All validation reads run before the write transaction. The transaction
      itself is intentionally limited to creating the request/approvals and,
      when fully auto-approved, applying the asset movement and history.
    */
    /*
      Run validation reads sequentially.

      The production database connection/pooler was closing the connection
      when four Prisma queries were opened together through Promise.all
      (Prisma P1017: Server has closed the connection). Sequential reads keep
      this workflow reliable on remote/pooler-backed databases.
    */
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId, deletedAt: null },
      include: { project: true },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    const targetProject = await this.prisma.project.findFirst({
      where: {
        id: toProjectId,
        deletedAt: null,
        isActive: true,
        companyId: asset.companyId,
      },
    });

    const requester = await this.prisma.user.findFirst({
      where: {
        id: requestedByUserId,
        companyId: asset.companyId,
        deletedAt: null,
        isActive: true,
      },
      include: { role: true },
    });

    const pending = await this.prisma.assetTransferRequest.findFirst({
      where: {
        assetId,
        status: { in: ['PENDING', 'PARTIALLY_APPROVED'] },
      },
      select: { id: true },
    });

    if (!asset.projectId) {
      throw new BadRequestException('Asset has no current project');
    }

    if (asset.projectId === toProjectId) {
      throw new BadRequestException('Asset already belongs to this project');
    }

    if (!targetProject || targetProject.companyId !== asset.companyId) {
      throw new BadRequestException('Target project is invalid');
    }

    if (!requester || requester.companyId !== asset.companyId) {
      throw new BadRequestException('Requester user is invalid or inactive');
    }

    const requesterRoleName = requester.role?.name || '';

    if (this.isAdminRole(requesterRoleName)) {
      throw new BadRequestException(
        'Admin cannot create asset transfer requests',
      );
    }

    if (
      !this.isOfficerRole(requesterRoleName) &&
      !this.isManagerRole(requesterRoleName)
    ) {
      throw new BadRequestException(
        'Only Officer or Manager can create asset transfer requests',
      );
    }

    if (!asset.project?.projectManagerId || !targetProject.projectManagerId) {
      throw new BadRequestException(
        'Asset transfer requires source and destination project managers',
      );
    }

    if (pending) {
      throw new BadRequestException('Pending transfer already exists');
    }

    const now = new Date();

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

    /*
      Avoid Prisma interactive transactions here.

      The remote/pooler-backed database was expiring the interactive
      transaction before the first write completed (P2028), even with a
      20-second timeout. These writes are therefore executed as short,
      independent Prisma calls. The shared validation above still guarantees
      the same business rules for single and bulk requests.
    */
    const transferRequest = await this.prisma.assetTransferRequest.create({
      data: {
        companyId: asset.companyId,
        assetId: asset.id,
        fromProjectId: asset.projectId!,
        toProjectId,
        requestedByUserId,
        transferBatchId: transferBatchId || null,
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
              reason:
                'Auto-applied because the requester manages all required approval stages',
            }
          : partiallyApproved
            ? {
                reason:
                  'Partially auto-approved because the requester manages one required approval stage',
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
        asset: true,
        fromProject: true,
        toProject: true,
        approvals: true,
      },
    });

    if (!fullyApproved) {
      return transferRequest;
    }

    await this.prisma.asset.update({
      where: { id: asset.id },
      data: { projectId: toProjectId },
    });

    await this.prisma.assetAssignmentHistory.create({
      data: {
        companyId: asset.companyId,
        assetId: asset.id,
        fromProjectId: asset.projectId,
        toProjectId,
        transferRequestId: transferRequest.id,
        assignmentType: 'TRANSFER' as any,
        reason: 'Asset transfer auto-approved and applied',
        assignedAt: now,
        assignedByUserId: requestedByUserId,
      },
    });

    return this.prisma.assetTransferRequest.findFirst({
      where: { id: transferRequest.id },
      include: {
        asset: true,
        fromProject: true,
        toProject: true,
        approvals: true,
      },
    });
  }

  async createTransferRequest(
    assetId: string,
    toProjectId: string,
    requestedByUserId: string,
    effectiveDateInput?: string,
  ) {
    if (!String(assetId || '').trim()) {
      throw new BadRequestException('Asset is required');
    }

    if (!String(toProjectId || '').trim()) {
      throw new BadRequestException('Target project is required');
    }

    if (!String(requestedByUserId || '').trim()) {
      throw new BadRequestException('Requester user is required');
    }

    return this.createTransferRequestCore(
      assetId,
      toProjectId,
      requestedByUserId,
      undefined,
      null,
    );
  }

  async createBulkTransferRequests(
    assetIds: string[],
    toProjectId: string,
    requestedByUserId: string,
    effectiveDateInput?: string,
  ) {
    const uniqueAssetIds = Array.from(
      new Set(
        (assetIds || [])
          .map((id) => String(id || '').trim())
          .filter(Boolean),
      ),
    );

    if (!uniqueAssetIds.length) {
      throw new BadRequestException('At least one asset is required');
    }

    if (!String(toProjectId || '').trim()) {
      throw new BadRequestException('Target project is required');
    }

    if (!String(requestedByUserId || '').trim()) {
      throw new BadRequestException('Requester user is required');
    }

    /*
      One batch reference is shared by all asset-transfer records created from
      this bulk submission. Each asset still keeps its own unique request ID,
      status, approvals and assignment history.
    */
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const transferBatchId =
      `ATB-${datePart}-${randomUUID().slice(0, 8).toUpperCase()}`;

    /*
      Process each asset sequentially to avoid overloading the remote database
      connection pool. Every item uses the same shared transfer logic.
    */
    const transfers: any[] = [];

    for (const assetId of uniqueAssetIds) {
      transfers.push(
        await this.createTransferRequestCore(
          assetId,
          toProjectId,
          requestedByUserId,
          undefined,
          transferBatchId,
        ),
      );
    }

    return {
      transferBatchId,
      requestedCount: uniqueAssetIds.length,
      createdCount: transfers.length,
      transfers,
    };
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

  async getTransferHistory(companyId?: string) {
    return this.prisma.assetTransferRequest.findMany({
      where: {
        ...(companyId ? { companyId } : {}),
      },
      include: {
        asset: {
          select: {
            id: true,
            assetId: true,
            type: true,
            category: true,
            companyId: true,
          },
        },
        company: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        fromProject: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        toProject: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        requestedBy: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
        approvals: {
          include: {
            approver: {
              select: {
                id: true,
                fullName: true,
                email: true,
              },
            },
            project: {
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
          },
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async reviewTransfer(
    transferId: string,
    managerUserId: string,
    approve: boolean,
    rejectionReason?: string,
  ) {
    /*
      Load the request and all current approvals before starting the transaction.
      This keeps the interactive transaction focused on writes and avoids Prisma
      P2028 errors when a remote database connection exceeds the 5-second limit.
    */
    const request = await this.prisma.assetTransferRequest.findFirst({
      where: { id: transferId },
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

    const now = new Date();
    const pendingApproval = request.approvals.find(
      (approval) =>
        approval.approverUserId === managerUserId &&
        approval.status === 'PENDING',
    );

    if (!pendingApproval) {
      throw new BadRequestException(
        'User cannot approve this asset transfer',
      );
    }

    if (!approve) {
      return this.prisma.$transaction(async (tx) => {
        await tx.assetTransferApproval.update({
          where: { id: pendingApproval.id },
          data: {
            status: 'REJECTED',
            note: rejectionReason || 'Rejected',
            reviewedAt: now,
          },
        });

        return tx.assetTransferRequest.update({
          where: { id: transferId },
          data: {
            status: 'REJECTED',
            rejectedAt: now,
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

    /*
      Decide whether this is the final required approval from the approvals that
      were already loaded. The current pending approval is treated as approved.
    */
    const hasOtherPendingApprovals = request.approvals.some(
      (approval) =>
        approval.id !== pendingApproval.id &&
        approval.status === 'PENDING',
    );

    if (hasOtherPendingApprovals) {
      return this.prisma.$transaction(async (tx) => {
        await tx.assetTransferApproval.update({
          where: { id: pendingApproval.id },
          data: {
            status: 'APPROVED',
            reviewedAt: now,
          },
        });

        return tx.assetTransferRequest.update({
          where: { id: transferId },
          data: {
            status: 'PARTIALLY_APPROVED',
            reason: request.reason
              ? `${request.reason}; Approval by manager ${managerUserId}`
              : `First approval by manager ${managerUserId}`,
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

    /*
      Final approval transaction:
      - approve the pending approval
      - move the asset
      - create assignment history
      - finalize the transfer request

      No additional reads run inside this transaction.
    */
    return this.prisma.$transaction(async (tx) => {
      await tx.assetTransferApproval.update({
        where: { id: pendingApproval.id },
        data: {
          status: 'APPROVED',
          reviewedAt: now,
        },
      });

      await tx.asset.update({
        where: { id: request.assetId },
        data: { projectId: request.toProjectId },
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
          assignedAt: now,
          assignedByUserId: managerUserId,
        },
      });

      return tx.assetTransferRequest.update({
        where: { id: transferId },
        data: {
          status: 'APPROVED',
          approvedAt: now,
          appliedAt: now,
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
      where: { id },
      data: {
        deletedAt: new Date(),
        status: 'INACTIVE',
      },
      include: {
        company: {
          select: { id: true, name: true, code: true },
        },
        project: {
          select: {
            id: true,
            code: true,
            name: true,
            projectManagerId: true,
          },
        },
      },
    });
  }
}
