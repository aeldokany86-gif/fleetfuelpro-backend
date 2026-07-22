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
    return String(assetId || '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '');
  }

  private mapAssetStatus(status?: string) {
    const normalized = String(status || 'ACTIVE')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');

    if (normalized === 'INACTIVE') return 'INACTIVE';
    return 'ACTIVE';
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

  private parseOptionalEffectiveDate(value?: string | null) {
    if (!value) return null;

    const effectiveDate = new Date(value);
    if (Number.isNaN(effectiveDate.getTime())) {
      throw new BadRequestException('Invalid effective date');
    }

    return effectiveDate;
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
          currentLifetimeOdometer:
            body.currentOdometer === undefined || body.currentOdometer === null
              ? 0
              : Number(body.currentOdometer),
          currentMeterCycle: 1,
          projectId: body.projectId || null,
          status: this.mapAssetStatus(body.status) as any,
          createdById: body.createdById || null,
        },
        include: {
          company: {
            select: { id: true, name: true, code: true },
          },
          project: {
            select: { id: true, code: true, name: true, projectManagerId: true },
          },
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
          currentOdometer: true,
          currentLifetimeOdometer: true,
          currentMeterCycle: true,
        },
      }),
      this.prisma.operation.findFirst({
        where: {
          assetId: id,
          status: 'COMPLETED',
          odometer: { not: null },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          operationNo: true,
          createdAt: true,
        },
      }),
    ]);

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    /*
      Backdated resets change the meaning of later operations and therefore
      belong to the historical-correction workflow, not the normal reset flow.
    */
    if (
      latestCompletedOperation &&
      effectiveAt.getTime() < latestCompletedOperation.createdAt.getTime()
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
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          odometer: true,
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
        at: operation.createdAt,
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

  async createTransferRequest(
    assetId: string,
    toProjectId: string,
    requestedByUserId: string,
    effectiveDateInput?: string,
  ) {
    // ✅ OPTIMIZATION: كل الـ validation queries بتشتغل بالتوازي
    // الأصل: 4 queries متسلسلة × ~500ms = ~2000ms+
    // بعد التعديل: 4 queries معاً = ~500ms فقط
    const [asset, targetProject, requester, pending] = await Promise.all([
      this.prisma.asset.findFirst({
        where: { id: assetId, deletedAt: null },
        include: { project: true },
      }),
      this.prisma.project.findFirst({
        where: {
          id: toProjectId,
          deletedAt: null,
          isActive: true,
        },
      }),
      this.prisma.user.findFirst({
        where: {
          id: requestedByUserId,
          deletedAt: null,
          isActive: true,
        },
        include: { role: true },
      }),
      this.prisma.assetTransferRequest.findFirst({
        where: {
          assetId,
          status: { in: ['PENDING', 'PARTIALLY_APPROVED'] },
        },
        select: { id: true },
      }),
    ]);

    // --- Validations (نفس المنطق الأصلي بالظبط) ---

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

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

    // --- Transfer Logic (نفس المنطق الأصلي بالظبط) ---

    const now = new Date();
    const requestedEffectiveDate = this.parseOptionalEffectiveDate(effectiveDateInput);

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
        // If the same manager is responsible for both source and destination projects,
        // one approval is enough.
        list.findIndex(
          (candidate) => candidate.approverUserId === item.approverUserId,
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
      const transferRequest = await tx.assetTransferRequest.create({
        data: {
          companyId: asset.companyId,
          assetId: asset.id,
          fromProjectId: asset.projectId!,
          toProjectId,
          requestedByUserId,
          effectiveDate: fullyApproved
            ? requestedEffectiveDate || now
            : requestedEffectiveDate,
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
          asset: true,
          fromProject: true,
          toProject: true,
          approvals: true,
        },
      });

      if (!fullyApproved) {
        return transferRequest;
      }

      await tx.asset.update({
        where: { id: asset.id },
        data: { projectId: toProjectId },
      });

      await tx.assetAssignmentHistory.create({
        data: {
          companyId: asset.companyId,
          assetId: asset.id,
          fromProjectId: asset.projectId,
          toProjectId,
          transferRequestId: transferRequest.id,
          assignmentType: 'TRANSFER' as any,
          reason: 'Asset transfer auto-approved and applied',
          assignedAt: requestedEffectiveDate || now,
          assignedByUserId: requestedByUserId,
        },
      });

      return tx.assetTransferRequest.findFirst({
        where: { id: transferRequest.id },
        include: {
          asset: true,
          fromProject: true,
          toProject: true,
          approvals: true,
        },
      });
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
    const effectiveDate = request.effectiveDate || now;

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
          assignedAt: effectiveDate,
          assignedByUserId: managerUserId,
        },
      });

      return tx.assetTransferRequest.update({
        where: { id: transferId },
        data: {
          status: 'APPROVED',
          approvedAt: now,
          appliedAt: now,
          effectiveDate,
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
