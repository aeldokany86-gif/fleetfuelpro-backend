import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ImportBatchStatus,
  ImportType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AssetCreationDomainService } from '../assets/asset-creation-domain.service';
import { ImportsService } from './imports.service';

type ConfirmAssetsBatchInput = {
  batchId: string;
  actorUserId: string;
  actorRoleName: string;
  actorCompanyId: string;
};

type JsonRecord = Record<string, unknown>;

@Injectable()
export class AssetImportConfirmationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importsService: ImportsService,
    private readonly assetCreationDomainService: AssetCreationDomainService,
  ) {}

  async confirmAssetsBatch(input: ConfirmAssetsBatchInput) {
    const batch = await this.prisma.importBatch.findFirst({
      where: { id: input.batchId },
      include: { rows: { orderBy: { rowNumber: 'asc' } } },
    });

    if (!batch) throw new NotFoundException('Import batch not found');

    const context = await this.importsService.resolveImportContext(
      input.actorUserId,
      input.actorRoleName,
      input.actorCompanyId,
      batch.companyId,
    );

    if (batch.importType !== ImportType.ASSETS) {
      this.fail(
        'INVALID_TEMPLATE_TYPE',
        'This confirmation service supports Assets imports only',
      );
    }

    if (batch.status !== ImportBatchStatus.READY_TO_IMPORT) {
      this.fail(
        'INVALID_BATCH_STATUS',
        `Import batch cannot be confirmed while status is ${batch.status}`,
      );
    }

    if (
      batch.totalRows <= 0 ||
      batch.invalidRows !== 0 ||
      batch.validRows !== batch.totalRows ||
      batch.rows.length !== batch.totalRows ||
      batch.rows.some((row) => !row.isValid || !row.normalizedData)
    ) {
      this.fail(
        'BATCH_NOT_READY_TO_IMPORT',
        'Import batch contains invalid or incomplete validated rows',
      );
    }

    const preparedRows = batch.rows.map((row) => {
      const data = this.asObject(row.normalizedData);

      const assetId = this.requiredString(data.assetId);
      const assetType = this.requiredString(data.assetType);
      const projectCode = this.requiredString(data.projectCode);
      const projectId = this.requiredString(data.projectId);
      const currentOdometer = this.requiredNumber(data.currentOdometer);

      if (
        !assetId ||
        !assetType ||
        !projectCode ||
        !projectId ||
        currentOdometer === null
      ) {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `Validated snapshot is incomplete at Excel row ${row.rowNumber}`,
        );
      }

      if (this.requiredString(data.status) !== 'ACTIVE') {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `Validated asset status is invalid at Excel row ${row.rowNumber}`,
        );
      }

      const fuelTankCapacity = this.optionalNumber(data.fuelTankCapacity);

      if (
        currentOdometer < 0 ||
        (fuelTankCapacity !== null && fuelTankCapacity < 0)
      ) {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `Validated asset opening values are invalid at Excel row ${row.rowNumber}`,
        );
      }

      return {
        rowNumber: row.rowNumber,
        assetId:
          this.assetCreationDomainService.normalizeAssetId(assetId),
        assetType,
        category: this.optionalString(data.category),
        fuelTankCapacity,
        projectCode:
          this.assetCreationDomainService.normalizeProjectCode(projectCode),
        projectId,
        currentOdometer,
      };
    });

    const assetIds = preparedRows.map((row) => row.assetId);

    if (new Set(assetIds).size !== assetIds.length) {
      this.fail(
        'DUPLICATE_ASSET_ID_IN_FILE',
        'Validated snapshot contains duplicate Asset IDs',
      );
    }

    // Re-check mutable business data before opening the write transaction.
    // This keeps the ALL_OR_NOTHING transaction short even for large imports.
    const [existingAssets, projects] = await this.prisma.$transaction([
      this.prisma.asset.findMany({
        where: { companyId: batch.companyId },
        select: { assetId: true, deletedAt: true },
      }),
      this.prisma.project.findMany({
        where: {
          companyId: batch.companyId,
          id: { in: preparedRows.map((row) => row.projectId) },
        },
        select: {
          id: true,
          code: true,
          name: true,
          isActive: true,
          deletedAt: true,
        },
      }),
    ]);

    const existingByAssetId = new Map(
      existingAssets.map((asset) => [
        this.assetCreationDomainService.normalizeAssetId(asset.assetId),
        asset,
      ]),
    );

    for (const row of preparedRows) {
      const existing = existingByAssetId.get(row.assetId);

      if (existing) {
        this.fail(
          existing.deletedAt
            ? 'ASSET_ID_PREVIOUSLY_USED'
            : 'ASSET_ID_ALREADY_EXISTS',
          existing.deletedAt
            ? `Asset ID ${row.assetId} was previously used by a deleted asset`
            : `Asset ID ${row.assetId} already exists`,
        );
      }
    }

    const projectsById = new Map(
      projects.map((project) => [project.id, project]),
    );

    for (const row of preparedRows) {
      const project = projectsById.get(row.projectId);

      if (!project || project.deletedAt || !project.isActive) {
        this.fail(
          'PROJECT_NOT_AVAILABLE',
          `Project Code ${row.projectCode} is no longer an active project`,
        );
      }

      if (
        this.assetCreationDomainService.normalizeProjectCode(project.code) !==
        row.projectCode
      ) {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `Project snapshot changed for Excel row ${row.rowNumber}`,
        );
      }
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const lock = await tx.importBatch.updateMany({
          where: {
            id: batch.id,
            status: ImportBatchStatus.READY_TO_IMPORT,
          },
          data: {
            status: ImportBatchStatus.IMPORTING,
            startedAt: new Date(),
            confirmedAt: new Date(),
            confirmedByUserId: context.actor.id,
            failureCode: null,
            failureMessage: null,
            failedAt: null,
          },
        });

        if (lock.count !== 1) {
          this.fail(
            'INVALID_BATCH_STATUS',
            'Import batch is no longer ready to import',
          );
        }

        const createdAssets =
          await this.assetCreationDomainService.createAssetsBulk(
            tx,
            preparedRows.map((row) => ({
              companyId: batch.companyId,
              assetId: row.assetId,
              type: row.assetType,
              category: row.category,
              fuelTankCapacity: row.fuelTankCapacity,
              currentOdometer: row.currentOdometer,
              projectId: row.projectId,
              status: 'ACTIVE',
              createdById: context.actor.id,
            })),
          );

        const rowByAssetId = new Map(
          preparedRows.map((row) => [row.assetId, row.rowNumber]),
        );

        const importedAssets = createdAssets.map((asset) => ({
          id: asset.id,
          assetId: asset.assetId,
          rowNumber:
            rowByAssetId.get(
              this.assetCreationDomainService.normalizeAssetId(asset.assetId),
            ) || null,
        }));

        const completedBatch = await tx.importBatch.update({
          where: { id: batch.id },
          data: {
            status: ImportBatchStatus.COMPLETED,
            importedRows: importedAssets.length,
            failedRows: 0,
            completedAt: new Date(),
            failureCode: null,
            failureMessage: null,
            failedAt: null,
          },
        });

        return {
          batch: completedBatch,
          assets: importedAssets,
        };
      });

      return result;
    } catch (error) {
      await this.prisma.importBatch.updateMany({
        where: {
          id: batch.id,
          status: {
            in: [
              ImportBatchStatus.READY_TO_IMPORT,
              ImportBatchStatus.IMPORTING,
            ],
          },
        },
        data: {
          status: ImportBatchStatus.FAILED,
          failedAt: new Date(),
          failureCode: 'IMPORT_FAILED',
          failureMessage:
            error instanceof Error
              ? error.message
              : 'Assets import confirmation failed',
        },
      });

      throw error;
    }
  }

  private requiredString(value: unknown) {
    if (typeof value !== 'string') return '';
    return value.trim();
  }

  private optionalString(value: unknown) {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim();
    return normalized || null;
  }

  private requiredNumber(value: unknown): number | null {
    if (
      value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim() === '')
    ) {
      return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  private optionalNumber(value: unknown): number | null {
    if (
      value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim() === '')
    ) {
      return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  private asObject(value: unknown): JsonRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as JsonRecord;
  }

  private fail(code: string, message: string): never {
    throw new BadRequestException({ code, message });
  }
}
