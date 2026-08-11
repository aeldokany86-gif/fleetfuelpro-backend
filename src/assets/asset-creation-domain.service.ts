import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type PrismaWriter = Prisma.TransactionClient;

export type CreateAssetDomainInput = {
  companyId: string;
  assetId: string;
  type: string;
  category?: string | null;
  fuelTankCapacity?: number | null;
  currentOdometer?: number | null;
  projectId?: string | null;
  status?: string;
  createdById?: string | null;
};

@Injectable()
export class AssetCreationDomainService {
  normalizeAssetId(assetId: string) {
    return String(assetId || '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '');
  }

  normalizeProjectCode(projectCode: string) {
    return String(projectCode || '')
      .trim()
      .toUpperCase();
  }

  mapAssetStatus(status?: string) {
    const normalized = String(status || 'ACTIVE')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');

    if (normalized === 'INACTIVE') return 'INACTIVE';
    return 'ACTIVE';
  }

  private buildAssetData(input: CreateAssetDomainInput) {
    const currentOdometer =
      input.currentOdometer === undefined || input.currentOdometer === null
        ? 0
        : Number(input.currentOdometer);

    return {
      companyId: input.companyId,
      assetId: this.normalizeAssetId(input.assetId),
      type: String(input.type || '').trim(),
      category: String(input.category || '').trim() || null,
      fuelTankCapacity:
        input.fuelTankCapacity === undefined || input.fuelTankCapacity === null
          ? null
          : Number(input.fuelTankCapacity),
      currentOdometer,
      currentLifetimeOdometer: currentOdometer,
      currentMeterCycle: 1,
      projectId: input.projectId || null,
      status: this.mapAssetStatus(input.status) as any,
      createdById: input.createdById || null,
    };
  }

  async createAsset(
    writer: PrismaWriter,
    input: CreateAssetDomainInput,
  ) {
    const data = this.buildAssetData(input);

    return writer.asset.create({
      data: {
        ...data,
        ...(data.projectId
          ? {
              assignmentHistory: {
                create: {
                  companyId: data.companyId,
                  fromProjectId: null,
                  toProjectId: data.projectId,
                  transferRequestId: null,
                  assignmentType: 'INITIAL_ASSIGNMENT' as any,
                  reason: 'Initial asset project assignment',
                  assignedAt: new Date(),
                  assignedByUserId: data.createdById,
                },
              },
            }
          : {}),
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

  async createAssetsBulk(
    tx: Prisma.TransactionClient,
    inputs: CreateAssetDomainInput[],
  ) {
    if (inputs.length === 0) return [];

    const prepared = inputs.map((input) => this.buildAssetData(input));

    const createdAssets = await tx.asset.createManyAndReturn({
      data: prepared,
      select: {
        id: true,
        assetId: true,
        type: true,
        category: true,
        fuelTankCapacity: true,
        currentOdometer: true,
        currentLifetimeOdometer: true,
        currentMeterCycle: true,
        projectId: true,
        status: true,
      },
    });

    const createdByAssetId = new Map(
      createdAssets.map((asset) => [
        this.normalizeAssetId(asset.assetId),
        asset,
      ]),
    );

    const assignmentRows = prepared
      .filter((item) => item.projectId)
      .map((item) => {
        const created = createdByAssetId.get(
          this.normalizeAssetId(item.assetId),
        );

        if (!created) {
          throw new Error(
            `Created asset could not be resolved for initial assignment: ${item.assetId}`,
          );
        }

        return {
          companyId: item.companyId,
          assetId: created.id,
          fromProjectId: null,
          toProjectId: item.projectId!,
          transferRequestId: null,
          assignmentType: 'INITIAL_ASSIGNMENT' as any,
          reason: 'Initial asset project assignment',
          assignedAt: new Date(),
          assignedByUserId: item.createdById,
        };
      });

    if (assignmentRows.length > 0) {
      await tx.assetAssignmentHistory.createMany({
        data: assignmentRows,
      });
    }

    return createdAssets;
  }
}
