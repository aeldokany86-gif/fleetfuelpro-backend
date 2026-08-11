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
import { StationCreationDomainService } from '../stations/station-creation-domain.service';
import { ImportsService } from './imports.service';

type ValidateStationsBatchInput = {
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

type ValidatedStationRow = {
  id: string;
  rowNumber: number;
  normalizedData: Record<string, Prisma.InputJsonValue>;
  computedData: Record<string, Prisma.InputJsonValue>;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  isValid: boolean;
};

@Injectable()
export class StationImportValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importsService: ImportsService,
    private readonly stationCreationDomainService: StationCreationDomainService,
  ) {}

  async validateStationsBatch(input: ValidateStationsBatchInput) {
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

    if (batch.importType !== ImportType.STATIONS) {
      this.fail(
        'INVALID_TEMPLATE_TYPE',
        'This validation service supports Stations imports only',
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
        'The uploaded Stations template contains no data rows',
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

      this.applyDuplicateStationIdErrors(rows);

      const stationIds = Array.from(
        new Set(
          rows
            .map((row) => this.getNormalizedString(row, 'stationId'))
            .filter((value): value is string => Boolean(value)),
        ),
      );

      const projectCodes = Array.from(
        new Set(
          rows
            .map((row) => this.getNormalizedString(row, 'projectCode'))
            .filter((value): value is string => Boolean(value)),
        ),
      );

      const [existingStations, projects] = await this.prisma.$transaction([
        this.prisma.station.findMany({
          where: {
            companyId: batch.companyId,
            stationId: { in: stationIds, mode: 'insensitive' },
          },
          select: { stationId: true, deletedAt: true },
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

      const existingStationById = new Map(
        existingStations.map((station) => [
          this.stationCreationDomainService.normalizeStationId(
            station.stationId,
          ),
          station,
        ]),
      );

      const projectByCode = new Map(
        projects.map((project) => [
          this.stationCreationDomainService.normalizeProjectCode(project.code),
          project,
        ]),
      );

      for (const row of rows) {
        const stationId = this.getNormalizedString(row, 'stationId');
        const projectCode = this.getNormalizedString(row, 'projectCode');

        if (stationId) {
          const existingStation = existingStationById.get(stationId);
          if (existingStation) {
            this.addError(row, {
              code: existingStation.deletedAt
                ? 'STATION_ID_PREVIOUSLY_USED'
                : 'STATION_ID_ALREADY_EXISTS',
              field: 'stationId',
              message: existingStation.deletedAt
                ? 'Station ID was previously used by a deleted station in this company'
                : 'Station ID already exists in this company',
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
            row.computedData.projectName = project.name;
            row.computedData.projectId = project.id;
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
              : 'Stations import validation failed',
        },
      });

      throw error;
    }
  }

  async getStationsPreview(input: ValidateStationsBatchInput) {
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

    if (batch.importType !== ImportType.STATIONS) {
      this.fail(
        'INVALID_TEMPLATE_TYPE',
        'This preview service supports Stations imports only',
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
  ): ValidatedStationRow {
    const stationId = this.stationCreationDomainService.normalizeStationId(
      this.text(source.stationId),
    );
    const stationName = this.text(source.stationName).trim();
    const stationType = this.text(source.stationType).trim();
    const projectCode =
      this.stationCreationDomainService.normalizeProjectCode(
        this.text(source.projectCode),
      );

    const capacity = this.optionalNumber(source.capacity);
    const openingBalance = this.requiredNumber(source.openingBalance);
    const currentCounter = this.requiredNumber(source.currentCounter);

    const row: ValidatedStationRow = {
      id,
      rowNumber,
      normalizedData: {
        stationId,
        stationName,
        stationType,
        capacity: capacity ?? '',
        projectCode,
        openingBalance: openingBalance ?? '',
        currentCounter: currentCounter ?? '',
        status: 'ACTIVE',
      },
      computedData: {
        status: 'ACTIVE',
        currentStock: openingBalance ?? '',
        currentLifetimeCounter: currentCounter ?? '',
        currentCounterCycle: 1,
      },
      errors: [],
      warnings: [],
      isValid: false,
    };

    if (!stationId) {
      this.addError(row, {
        code: 'EMPTY_STATION_ID',
        field: 'stationId',
        message: 'Station ID is required',
      });
    }

    if (!projectCode) {
      this.addError(row, {
        code: 'EMPTY_PROJECT_CODE',
        field: 'projectCode',
        message: 'Project Code is required',
      });
    }

    if (openingBalance === null) {
      this.addError(row, {
        code: 'INVALID_OPENING_BALANCE',
        field: 'openingBalance',
        message: 'Opening Balance is required and must be a valid number',
      });
    } else if (openingBalance < 0) {
      this.addError(row, {
        code: 'NEGATIVE_OPENING_BALANCE',
        field: 'openingBalance',
        message: 'Opening Balance must be zero or positive',
      });
    }

    if (currentCounter === null) {
      this.addError(row, {
        code: 'INVALID_CURRENT_COUNTER',
        field: 'currentCounter',
        message: 'Current Counter is required and must be a valid number',
      });
    } else if (currentCounter < 0) {
      this.addError(row, {
        code: 'NEGATIVE_CURRENT_COUNTER',
        field: 'currentCounter',
        message: 'Current Counter must be zero or positive',
      });
    }

    if (
      !this.isBlank(source.capacity) &&
      capacity === null
    ) {
      this.addError(row, {
        code: 'INVALID_CAPACITY',
        field: 'capacity',
        message: 'Capacity must be a valid number when provided',
      });
    }

    return row;
  }

  private applyDuplicateStationIdErrors(rows: ValidatedStationRow[]) {
    const byStationId = new Map<string, ValidatedStationRow[]>();

    for (const row of rows) {
      const stationId = this.getNormalizedString(row, 'stationId');
      if (!stationId) continue;

      const list = byStationId.get(stationId) || [];
      list.push(row);
      byStationId.set(stationId, list);
    }

    for (const duplicateRows of byStationId.values()) {
      if (duplicateRows.length < 2) continue;

      for (const row of duplicateRows) {
        this.addError(row, {
          code: 'DUPLICATE_STATION_ID_IN_FILE',
          field: 'stationId',
          message: 'Station ID is duplicated in the uploaded file',
        });
      }
    }
  }

  private getNormalizedString(
    row: ValidatedStationRow,
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
    return value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim() === '');
  }

  private addError(row: ValidatedStationRow, issue: ValidationIssue) {
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
