import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ImportBatchStatus,
  ImportType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AssetCreationDomainService } from '../assets/asset-creation-domain.service';
import { ImportsService } from './imports.service';

type ValidateAssetsBatchInput = {
  batchId: string;
  actorUserId: string;
  actorRoleName: string;
  actorCompanyId: string;
};

type ValidationIssue = {
  code: string;
  field?: string;
  message: string;
};

type JsonRecord = Record<string, unknown>;

type ValidatedAssetRow = {
  id: string;
  rowNumber: number;
  normalizedData: Record<string, Prisma.InputJsonValue>;
  computedData: Record<string, Prisma.InputJsonValue>;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  isValid: boolean;
};

@Injectable()
export class AssetImportValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importsService: ImportsService,
    private readonly assetCreationDomainService: AssetCreationDomainService,
  ) {}

  async validateAssetsBatch(input: ValidateAssetsBatchInput) {
    const batch = await this.prisma.importBatch.findFirst({
      where: { id: input.batchId },
      include: { rows: { orderBy: { rowNumber: 'asc' } } },
    });

    if (!batch) throw new NotFoundException('Import batch not found');

    await this.importsService.resolveImportContext(
      input.actorUserId,
      input.actorRoleName,
      input.actorCompanyId,
      batch.companyId,
    );

    if (batch.importType !== ImportType.ASSETS) {
      this.fail(
        'INVALID_TEMPLATE_TYPE',
        'This validation service supports Assets imports only',
      );
    }

    if (
      batch.status !== ImportBatchStatus.UPLOADED &&
      batch.status !== ImportBatchStatus.VALIDATED &&
      batch.status !== ImportBatchStatus.READY_TO_IMPORT
    ) {
      this.fail(
        'INVALID_BATCH_STATUS',
        `Import batch cannot be validated while status is ${batch.status}`,
      );
    }

    if (batch.rows.length === 0) {
      this.fail(
        'EMPTY_IMPORT_FILE',
        'The uploaded Assets template contains no data rows',
      );
    }

    await this.prisma.importBatch.update({
      where: { id: batch.id },
      data: {
        status: ImportBatchStatus.VALIDATING,
        validatedAt: null,
        failureCode: null,
        failureMessage: null,
      },
    });

    try {
      const rows = batch.rows.map((row) =>
        this.validateRowShape(
          row.id,
          row.rowNumber,
          this.asObject(row.sourceData),
        ),
      );

      this.applyDuplicateAssetIdErrors(rows);

      const projectCodes = Array.from(
        new Set(
          rows
            .map((row) => this.getNormalizedString(row, 'projectCode'))
            .filter((value): value is string => Boolean(value)),
        ),
      );

      const [existingAssets, projects] = await this.prisma.$transaction([
        this.prisma.asset.findMany({
          where: { companyId: batch.companyId },
          select: { assetId: true, deletedAt: true },
        }),
        this.prisma.project.findMany({
          where: {
            companyId: batch.companyId,
            code: { in: projectCodes, mode: 'insensitive' },
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

      const existingAssetById = new Map(
        existingAssets.map((asset) => [
          this.assetCreationDomainService.normalizeAssetId(asset.assetId),
          asset,
        ]),
      );

      const projectByCode = new Map(
        projects.map((project) => [
          this.assetCreationDomainService.normalizeProjectCode(project.code),
          project,
        ]),
      );

      for (const row of rows) {
        const assetId = this.getNormalizedString(row, 'assetId');
        const projectCode = this.getNormalizedString(row, 'projectCode');

        if (assetId) {
          const existingAsset = existingAssetById.get(assetId);

          if (existingAsset) {
            this.addError(row, {
              code: existingAsset.deletedAt
                ? 'ASSET_ID_PREVIOUSLY_USED'
                : 'ASSET_ID_ALREADY_EXISTS',
              field: 'assetId',
              message: existingAsset.deletedAt
                ? 'Asset ID was previously used by a deleted asset in this company'
                : 'Asset ID already exists in this company',
            });
          }
        }

        if (projectCode) {
          const project = projectByCode.get(projectCode);

          if (!project || project.deletedAt) {
            this.addError(row, {
              code: 'PROJECT_CODE_NOT_FOUND',
              field: 'projectCode',
              message:
                'Project Code does not identify an existing project in this company',
            });
          } else if (!project.isActive) {
            this.addError(row, {
              code: 'PROJECT_INACTIVE',
              field: 'projectCode',
              message: 'Project Code identifies an inactive project',
            });
          } else {
            row.normalizedData.projectId = project.id;
            row.computedData.projectId = project.id;
            row.computedData.projectName = project.name;
          }
        }

        row.isValid = row.errors.length === 0;
      }

      const validRows = rows.filter((row) => row.isValid).length;
      const invalidRows = rows.length - validRows;
      const warningRows = rows.filter((row) => row.warnings.length > 0).length;

      const finalStatus =
        invalidRows === 0
          ? ImportBatchStatus.READY_TO_IMPORT
          : ImportBatchStatus.VALIDATED;

      await this.prisma.$transaction([
        ...rows.map((row) =>
          this.prisma.importRow.update({
            where: { id: row.id },
            data: {
              normalizedData: row.normalizedData,
              computedData: row.computedData,
              errors: row.errors as unknown as Prisma.InputJsonValue,
              warnings: row.warnings as unknown as Prisma.InputJsonValue,
              isValid: row.isValid,
            },
          }),
        ),
        this.prisma.importBatch.update({
          where: { id: batch.id },
          data: {
            status: finalStatus,
            totalRows: rows.length,
            validRows,
            invalidRows,
            warningRows,
            validatedAt: new Date(),
            failureCode: null,
            failureMessage: null,
          },
        }),
      ]);

      return this.getValidationResult(batch.id);
    } catch (error) {
      await this.prisma.importBatch.update({
        where: { id: batch.id },
        data: {
          status: ImportBatchStatus.FAILED,
          failedAt: new Date(),
          failureCode: 'VALIDATION_FAILED',
          failureMessage:
            error instanceof Error
              ? error.message
              : 'Assets import validation failed',
        },
      });

      throw error;
    }
  }

  async getAssetsPreview(input: ValidateAssetsBatchInput) {
    const batch = await this.prisma.importBatch.findFirst({
      where: { id: input.batchId },
      include: {
        company: { select: { id: true, code: true, name: true } },
        rows: { orderBy: { rowNumber: 'asc' } },
      },
    });

    if (!batch) throw new NotFoundException('Import batch not found');

    await this.importsService.resolveImportContext(
      input.actorUserId,
      input.actorRoleName,
      input.actorCompanyId,
      batch.companyId,
    );

    if (batch.importType !== ImportType.ASSETS) {
      this.fail(
        'INVALID_TEMPLATE_TYPE',
        'This preview service supports Assets imports only',
      );
    }

    if (
      batch.status !== ImportBatchStatus.VALIDATED &&
      batch.status !== ImportBatchStatus.READY_TO_IMPORT
    ) {
      this.fail(
        'INVALID_BATCH_STATUS',
        `Import batch cannot be previewed while status is ${batch.status}`,
      );
    }

    return {
      batchId: batch.id,
      importType: batch.importType,
      schemaVersion: batch.schemaVersion,
      templateLanguage: batch.templateLanguage,
      status: batch.status,
      executionMode: batch.executionMode,
      company: batch.company,
      summary: {
        totalRows: batch.totalRows,
        validRows: batch.validRows,
        invalidRows: batch.invalidRows,
        warningRows: batch.warningRows,
        canConfirm:
          batch.status === ImportBatchStatus.READY_TO_IMPORT &&
          batch.invalidRows === 0 &&
          batch.totalRows > 0,
      },
      rows: batch.rows.map((row) => ({
        id: row.id,
        rowNumber: row.rowNumber,
        sourceData: this.asObject(row.sourceData),
        normalizedData: this.asObject(row.normalizedData),
        computedData: this.asObject(row.computedData),
        errors: this.asIssues(row.errors),
        warnings: this.asIssues(row.warnings),
        isValid: row.isValid,
      })),
    };
  }

  private async getValidationResult(batchId: string) {
    const batch = await this.prisma.importBatch.findUniqueOrThrow({
      where: { id: batchId },
      include: { rows: { orderBy: { rowNumber: 'asc' } } },
    });

    return {
      batch: {
        id: batch.id,
        importType: batch.importType,
        status: batch.status,
        totalRows: batch.totalRows,
        validRows: batch.validRows,
        invalidRows: batch.invalidRows,
        warningRows: batch.warningRows,
      },
      rows: batch.rows.map((row) => ({
        id: row.id,
        rowNumber: row.rowNumber,
        normalizedData: this.asObject(row.normalizedData),
        computedData: this.asObject(row.computedData),
        errors: this.asIssues(row.errors),
        warnings: this.asIssues(row.warnings),
        isValid: row.isValid,
      })),
    };
  }

  private validateRowShape(
    id: string,
    rowNumber: number,
    source: JsonRecord,
  ): ValidatedAssetRow {
    const assetId = this.assetCreationDomainService.normalizeAssetId(
      this.text(source.assetId),
    );
    const assetType = this.text(source.assetType).trim();
    const category = this.text(source.category).trim();
    const projectCode =
      this.assetCreationDomainService.normalizeProjectCode(
        this.text(source.projectCode),
      );

    const fuelTankCapacity = this.optionalNumber(source.fuelTankCapacity);
    const currentOdometer = this.requiredNumber(source.currentOdometer);

    const row: ValidatedAssetRow = {
      id,
      rowNumber,
      normalizedData: {
        assetId,
        assetType,
        category,
        fuelTankCapacity: fuelTankCapacity ?? '',
        projectCode,
        currentOdometer: currentOdometer ?? '',
        status: 'ACTIVE',
      },
      computedData: {
        status: 'ACTIVE',
        currentLifetimeOdometer: currentOdometer ?? '',
        currentMeterCycle: 1,
      },
      errors: [],
      warnings: [],
      isValid: false,
    };

    if (!assetId) {
      this.addError(row, {
        code: 'EMPTY_ASSET_ID',
        field: 'assetId',
        message: 'Asset ID is required',
      });
    }

    if (!assetType) {
      this.addError(row, {
        code: 'EMPTY_ASSET_TYPE',
        field: 'assetType',
        message: 'Asset Type is required',
      });
    }

    if (!projectCode) {
      this.addError(row, {
        code: 'EMPTY_PROJECT_CODE',
        field: 'projectCode',
        message: 'Project Code is required',
      });
    }

    if (
      !this.isBlank(source.fuelTankCapacity) &&
      fuelTankCapacity === null
    ) {
      this.addError(row, {
        code: 'INVALID_FUEL_TANK_CAPACITY',
        field: 'fuelTankCapacity',
        message: 'Fuel Tank Capacity must be a valid number when provided',
      });
    } else if (fuelTankCapacity !== null && fuelTankCapacity < 0) {
      this.addError(row, {
        code: 'NEGATIVE_FUEL_TANK_CAPACITY',
        field: 'fuelTankCapacity',
        message: 'Fuel Tank Capacity must be zero or positive',
      });
    }

    if (currentOdometer === null) {
      this.addError(row, {
        code: 'INVALID_CURRENT_ODOMETER',
        field: 'currentOdometer',
        message: 'Current Odometer is required and must be a valid number',
      });
    } else if (currentOdometer < 0) {
      this.addError(row, {
        code: 'NEGATIVE_CURRENT_ODOMETER',
        field: 'currentOdometer',
        message: 'Current Odometer must be zero or positive',
      });
    }

    return row;
  }

  private applyDuplicateAssetIdErrors(rows: ValidatedAssetRow[]) {
    const byAssetId = new Map<string, ValidatedAssetRow[]>();

    for (const row of rows) {
      const assetId = this.getNormalizedString(row, 'assetId');
      if (!assetId) continue;

      const list = byAssetId.get(assetId) || [];
      list.push(row);
      byAssetId.set(assetId, list);
    }

    for (const duplicateRows of byAssetId.values()) {
      if (duplicateRows.length < 2) continue;

      for (const row of duplicateRows) {
        this.addError(row, {
          code: 'DUPLICATE_ASSET_ID_IN_FILE',
          field: 'assetId',
          message: 'Asset ID is duplicated in the uploaded file',
        });
      }
    }
  }

  private getNormalizedString(
    row: ValidatedAssetRow,
    field: string,
  ) {
    const value = row.normalizedData[field];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private optionalNumber(value: unknown): number | null {
    if (this.isBlank(value)) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  private requiredNumber(value: unknown): number | null {
    if (this.isBlank(value)) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  private isBlank(value: unknown) {
    return (
      value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim() === '')
    );
  }

  private addError(row: ValidatedAssetRow, issue: ValidationIssue) {
    if (
      !row.errors.some(
        (item) => item.code === issue.code && item.field === issue.field,
      )
    ) {
      row.errors.push(issue);
    }
  }

  private text(value: unknown) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  private asObject(value: unknown): JsonRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as JsonRecord;
  }

  private asIssues(value: unknown): ValidationIssue[] {
    return Array.isArray(value) ? (value as ValidationIssue[]) : [];
  }

  private fail(code: string, message: string): never {
    throw new BadRequestException({ code, message });
  }
}
