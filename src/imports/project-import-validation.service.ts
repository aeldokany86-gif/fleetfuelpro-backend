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
import { ImportsService } from './imports.service';

type ValidateProjectsBatchInput = {
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

type ValidatedProjectRow = {
  id: string;
  rowNumber: number;
  normalizedData: Record<string, Prisma.InputJsonValue>;
  computedData: Record<string, Prisma.InputJsonValue>;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  isValid: boolean;
};

@Injectable()
export class ProjectImportValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importsService: ImportsService,
  ) {}

  async validateProjectsBatch(input: ValidateProjectsBatchInput) {
    const batch = await this.prisma.importBatch.findFirst({
      where: {
        id: input.batchId,
      },
      include: {
        rows: {
          orderBy: {
            rowNumber: 'asc',
          },
        },
      },
    });

    if (!batch) {
      throw new NotFoundException('Import batch not found');
    }

    await this.importsService.resolveImportContext(
      input.actorUserId,
      input.actorRoleName,
      input.actorCompanyId,
      batch.companyId,
    );

    if (batch.importType !== ImportType.PROJECTS) {
      this.fail(
        'INVALID_TEMPLATE_TYPE',
        'This validation endpoint supports Projects imports only',
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
        'The uploaded Projects template contains no data rows',
      );
    }

    await this.prisma.importBatch.update({
      where: {
        id: batch.id,
      },
      data: {
        status: ImportBatchStatus.VALIDATING,
        validatedAt: null,
        failureCode: null,
        failureMessage: null,
      },
    });

    try {
      const preliminaryRows = batch.rows.map((row) =>
        this.validateProjectRowShape(
          row.id,
          row.rowNumber,
          this.asObject(row.sourceData),
        ),
      );

      this.applyDuplicateInFileErrors(preliminaryRows);

      const candidateCodes = Array.from(
        new Set(
          preliminaryRows
            .map((row) => this.getNormalizedString(row, 'projectCode'))
            .filter((value): value is string => Boolean(value)),
        ),
      );

      const existingProjects =
        candidateCodes.length > 0
          ? await this.prisma.project.findMany({
              where: {
                companyId: batch.companyId,
                code: {
                  in: candidateCodes,
                  mode: 'insensitive',
                },
              },
              select: {
                code: true,
                deletedAt: true,
              },
            })
          : [];

      const existingByCode = new Map(
        existingProjects.map((project) => [
          this.normalizeProjectCode(project.code),
          project,
        ]),
      );

      for (const row of preliminaryRows) {
        const projectCode = this.getNormalizedString(row, 'projectCode');

        if (!projectCode) {
          continue;
        }

        const existing = existingByCode.get(projectCode);

        if (!existing) {
          continue;
        }

        if (existing.deletedAt) {
          this.addError(row, {
            code: 'PROJECT_CODE_PREVIOUSLY_USED',
            field: 'projectCode',
            message:
              'Project code was previously used by a deleted project in this company',
          });
        } else {
          this.addError(row, {
            code: 'PROJECT_CODE_ALREADY_EXISTS',
            field: 'projectCode',
            message:
              'Project code already exists in this company',
          });
        }
      }

      for (const row of preliminaryRows) {
        row.isValid = row.errors.length === 0;
      }

      const validRows = preliminaryRows.filter((row) => row.isValid).length;
      const invalidRows = preliminaryRows.length - validRows;
      const warningRows = preliminaryRows.filter(
        (row) => row.warnings.length > 0,
      ).length;

      const finalStatus =
        invalidRows === 0
          ? ImportBatchStatus.READY_TO_IMPORT
          : ImportBatchStatus.VALIDATED;

      const rowUpdates = preliminaryRows.map((row) =>
        this.prisma.importRow.update({
          where: {
            id: row.id,
          },
          data: {
            normalizedData: row.normalizedData,
            computedData: row.computedData,
            errors: row.errors as unknown as Prisma.InputJsonValue,
            warnings: row.warnings as unknown as Prisma.InputJsonValue,
            isValid: row.isValid,
          },
        }),
      );

      await this.prisma.$transaction([
        ...rowUpdates,
        this.prisma.importBatch.update({
          where: {
            id: batch.id,
          },
          data: {
            status: finalStatus,
            totalRows: preliminaryRows.length,
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
        where: {
          id: batch.id,
        },
        data: {
          status: ImportBatchStatus.FAILED,
          failedAt: new Date(),
          failureCode: 'VALIDATION_FAILED',
          failureMessage:
            error instanceof Error
              ? error.message
              : 'Projects import validation failed',
        },
      });

      throw error;
    }
  }

  async getProjectsPreview(input: ValidateProjectsBatchInput) {
    const batch = await this.prisma.importBatch.findFirst({
      where: {
        id: input.batchId,
      },
      include: {
        company: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        rows: {
          orderBy: {
            rowNumber: 'asc',
          },
          select: {
            id: true,
            rowNumber: true,
            sourceData: true,
            normalizedData: true,
            computedData: true,
            errors: true,
            warnings: true,
            isValid: true,
          },
        },
      },
    });

    if (!batch) {
      throw new NotFoundException('Import batch not found');
    }

    await this.importsService.resolveImportContext(
      input.actorUserId,
      input.actorRoleName,
      input.actorCompanyId,
      batch.companyId,
    );

    if (batch.importType !== ImportType.PROJECTS) {
      this.fail(
        'INVALID_TEMPLATE_TYPE',
        'This preview endpoint supports Projects imports only',
      );
    }

    if (
      batch.status !== ImportBatchStatus.VALIDATED &&
      batch.status !== ImportBatchStatus.READY_TO_IMPORT
    ) {
      this.fail(
        'BATCH_NOT_VALIDATED',
        'Import batch must be validated before preview',
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
          batch.invalidRows === 0,
      },
      rows: batch.rows.map((row) => ({
        rowId: row.id,
        rowNumber: row.rowNumber,
        sourceData: row.sourceData,
        normalizedData: row.normalizedData,
        computedData: row.computedData,
        errors: Array.isArray(row.errors) ? row.errors : [],
        warnings: Array.isArray(row.warnings) ? row.warnings : [],
        isValid: row.isValid,
      })),
    };
  }

  private validateProjectRowShape(
    id: string,
    rowNumber: number,
    sourceData: JsonRecord,
  ): ValidatedProjectRow {
    const row: ValidatedProjectRow = {
      id,
      rowNumber,
      normalizedData: {},
      computedData: {},
      errors: [],
      warnings: [],
      isValid: false,
    };

    const projectCode = this.optionalText(sourceData.projectCode);

    if (!projectCode) {
      this.addError(row, {
        code: 'EMPTY_PROJECT_CODE',
        field: 'projectCode',
        message: 'Project Code is required',
      });
    } else {
      const normalizedCode = this.normalizeProjectCode(projectCode);
      row.normalizedData.projectCode = normalizedCode;

      if (normalizedCode.length > 50) {
        this.addError(row, {
          code: 'PROJECT_CODE_TOO_LONG',
          field: 'projectCode',
          message: 'Project Code cannot exceed 50 characters',
        });
      }
    }

    const projectName = this.optionalText(sourceData.projectName);

    if (!projectName) {
      this.addError(row, {
        code: 'EMPTY_PROJECT_NAME',
        field: 'projectName',
        message: 'Project Name is required',
      });
    } else {
      row.normalizedData.projectName = projectName;

      if (projectName.length > 150) {
        this.addError(row, {
          code: 'PROJECT_NAME_TOO_LONG',
          field: 'projectName',
          message: 'Project Name cannot exceed 150 characters',
        });
      }
    }

    const location = this.optionalText(sourceData.location);

    if (location) {
      row.normalizedData.location = location;

      if (location.length > 150) {
        this.addError(row, {
          code: 'LOCATION_TOO_LONG',
          field: 'location',
          message: 'Location cannot exceed 150 characters',
        });
      }
    }

    const description = this.optionalText(sourceData.description);

    if (description) {
      row.normalizedData.description = description;

      if (description.length > 500) {
        this.addError(row, {
          code: 'DESCRIPTION_TOO_LONG',
          field: 'description',
          message: 'Description cannot exceed 500 characters',
        });
      }
    }

    const status = this.normalizeStatus(sourceData.status);

    if (!status) {
      this.addError(row, {
        code: 'INVALID_PROJECT_STATUS',
        field: 'status',
        message: 'Status must be ACTIVE or INACTIVE',
      });
    } else {
      row.normalizedData.status = status;
    }

    const projectStartDate = this.normalizeDate(
      sourceData.projectStartDate,
    );

    if (!projectStartDate) {
      this.addError(row, {
        code: 'INVALID_PROJECT_START_DATE',
        field: 'projectStartDate',
        message: 'Project Start Date is required and must be a valid date',
      });
    } else {
      row.normalizedData.projectStartDate = projectStartDate;

      const start = new Date(`${projectStartDate}T00:00:00.000Z`);
      const today = new Date();
      const todayUtc = new Date(
        Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate(),
        ),
      );

      if (start.getTime() > todayUtc.getTime()) {
        this.addWarning(row, {
          code: 'PROJECT_START_DATE_IN_FUTURE',
          field: 'projectStartDate',
          message: 'Project Start Date is in the future',
        });
      }
    }

    const basePrice = this.parseNumber(sourceData.basePricePerLiter);

    if (basePrice === null || basePrice <= 0) {
      this.addError(row, {
        code: 'INVALID_BASE_PRICE',
        field: 'basePricePerLiter',
        message: 'Base Price / Liter must be greater than 0',
      });
    } else {
      row.normalizedData.basePricePerLiter = basePrice;
    }

    const transportRaw = this.isEmpty(sourceData.transportCostPerLiter)
      ? 0
      : this.parseNumber(sourceData.transportCostPerLiter);

    if (transportRaw === null || transportRaw < 0) {
      this.addError(row, {
        code: 'INVALID_TRANSPORT_COST',
        field: 'transportCostPerLiter',
        message: 'Transport Cost / Liter must be 0 or greater',
      });
    } else {
      row.normalizedData.transportCostPerLiter = transportRaw;
    }

    const vatRaw = this.isEmpty(sourceData.vatRate)
      ? 0
      : this.parseNumber(sourceData.vatRate);

    if (vatRaw === null || vatRaw < 0 || vatRaw > 100) {
      this.addError(row, {
        code: 'INVALID_VAT_RATE',
        field: 'vatRate',
        message: 'VAT % must be between 0 and 100',
      });
    } else {
      row.normalizedData.vatRate = vatRaw;
    }

    if (
      basePrice !== null &&
      basePrice > 0 &&
      transportRaw !== null &&
      transportRaw >= 0 &&
      vatRaw !== null &&
      vatRaw >= 0 &&
      vatRaw <= 100
    ) {
      const netPrice = this.roundNumber(basePrice + transportRaw);
      const vatAmount = this.roundNumber(netPrice * (vatRaw / 100));
      const operationalPrice = this.roundNumber(netPrice + vatAmount);

      row.computedData.netPricePerLiter = netPrice;
      row.computedData.vatAmountPerLiter = vatAmount;
      row.computedData.operationalPricePerLiter = operationalPrice;
    }

    row.isValid = row.errors.length === 0;

    return row;
  }

  private applyDuplicateInFileErrors(rows: ValidatedProjectRow[]) {
    const rowsByCode = new Map<string, ValidatedProjectRow[]>();

    for (const row of rows) {
      const projectCode = this.getNormalizedString(row, 'projectCode');

      if (!projectCode) {
        continue;
      }

      const group = rowsByCode.get(projectCode) || [];
      group.push(row);
      rowsByCode.set(projectCode, group);
    }

    for (const group of rowsByCode.values()) {
      if (group.length <= 1) {
        continue;
      }

      for (const row of group) {
        this.addError(row, {
          code: 'DUPLICATE_PROJECT_CODE_IN_FILE',
          field: 'projectCode',
          message:
            'Project Code appears more than once in the uploaded file',
        });
      }
    }
  }

  private async getValidationResult(batchId: string) {
    const batch = await this.prisma.importBatch.findUniqueOrThrow({
      where: {
        id: batchId,
      },
      include: {
        company: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
        rows: {
          orderBy: {
            rowNumber: 'asc',
          },
          select: {
            id: true,
            rowNumber: true,
            sourceData: true,
            normalizedData: true,
            computedData: true,
            errors: true,
            warnings: true,
            isValid: true,
          },
        },
      },
    });

    return {
      batch: {
        id: batch.id,
        companyId: batch.companyId,
        importType: batch.importType,
        schemaVersion: batch.schemaVersion,
        validationVersion: batch.validationVersion,
        templateLanguage: batch.templateLanguage,
        originalFileName: batch.originalFileName,
        status: batch.status,
        executionMode: batch.executionMode,
        totalRows: batch.totalRows,
        validRows: batch.validRows,
        invalidRows: batch.invalidRows,
        warningRows: batch.warningRows,
        validatedAt: batch.validatedAt,
        company: batch.company,
      },
      rows: batch.rows,
    };
  }

  private getNormalizedString(
    row: ValidatedProjectRow,
    field: string,
  ): string | null {
    const value = row.normalizedData[field];

    return typeof value === 'string' && value.trim()
      ? value.trim()
      : null;
  }

  private normalizeProjectCode(value: string) {
    return value.trim().toUpperCase();
  }

  private optionalText(value: unknown): string | null {
    if (this.isEmpty(value)) {
      return null;
    }

    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      const text = String(value).trim();
      return text || null;
    }

    return null;
  }

  private normalizeStatus(value: unknown): 'ACTIVE' | 'INACTIVE' | null {
    const text = this.optionalText(value);

    if (!text) {
      return null;
    }

    const normalized = text
      .trim()
      .toUpperCase()
      .replace(/[\s_-]+/g, '');

    if (normalized === 'ACTIVE' || text.trim() === 'نشط') {
      return 'ACTIVE';
    }

    if (
      normalized === 'INACTIVE' ||
      text.trim() === 'غير نشط'
    ) {
      return 'INACTIVE';
    }

    return null;
  }

  private normalizeDate(value: unknown): string | null {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }

    if (typeof value !== 'string') {
      return null;
    }

    const text = value.trim();

    if (!text) {
      return null;
    }

    const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);

    if (!isoMatch) {
      return null;
    }

    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);

    const date = new Date(Date.UTC(year, month - 1, day));

    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }

    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  private parseNumber(value: unknown): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const text = value.trim();

    if (!text || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) {
      return null;
    }

    const parsed = Number(text);

    return Number.isFinite(parsed) ? parsed : null;
  }

  private isEmpty(value: unknown) {
    return (
      value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim() === '')
    );
  }

  private roundNumber(value: number) {
    return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
  }

  private asObject(value: Prisma.JsonValue): JsonRecord {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      return value as JsonRecord;
    }

    return {};
  }

  private addError(
    row: ValidatedProjectRow,
    issue: ValidationIssue,
  ) {
    if (
      !row.errors.some(
        (existing) =>
          existing.code === issue.code &&
          existing.field === issue.field,
      )
    ) {
      row.errors.push(issue);
    }

    row.isValid = false;
  }

  private addWarning(
    row: ValidatedProjectRow,
    issue: ValidationIssue,
  ) {
    if (
      !row.warnings.some(
        (existing) =>
          existing.code === issue.code &&
          existing.field === issue.field,
      )
    ) {
      row.warnings.push(issue);
    }
  }

  private fail(code: string, message: string): never {
    throw new BadRequestException({
      code,
      message,
    });
  }
}
