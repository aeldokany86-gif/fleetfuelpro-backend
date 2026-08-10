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
import { EmployeeCreationDomainService } from '../employees/employee-creation-domain.service';
import { ImportsService } from './imports.service';

type ValidateEmployeesBatchInput = {
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

type ValidatedEmployeeRow = {
  id: string;
  rowNumber: number;
  normalizedData: Record<string, Prisma.InputJsonValue>;
  computedData: Record<string, Prisma.InputJsonValue>;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  isValid: boolean;
};

@Injectable()
export class EmployeeImportValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importsService: ImportsService,
    private readonly employeeCreationDomainService: EmployeeCreationDomainService,
  ) {}

  async validateEmployeesBatch(input: ValidateEmployeesBatchInput) {
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

    if (batch.importType !== ImportType.EMPLOYEES) {
      this.fail(
        'INVALID_TEMPLATE_TYPE',
        'This validation service supports Employees imports only',
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
        'The uploaded Employees template contains no data rows',
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

      this.applyDuplicateEmployeeIdErrors(rows);

      const employeeIds = Array.from(
        new Set(
          rows
            .map((row) => this.getNormalizedString(row, 'employeeId'))
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

      const [existingEmployees, projects] = await this.prisma.$transaction([
        this.prisma.employee.findMany({
          where: {
            companyId: batch.companyId,
            employeeId: { in: employeeIds, mode: 'insensitive' },
          },
          select: { employeeId: true, deletedAt: true },
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

      const existingEmployeeById = new Map(
        existingEmployees.map((employee) => [
          this.employeeCreationDomainService.normalizeEmployeeId(
            employee.employeeId,
          ),
          employee,
        ]),
      );

      const projectByCode = new Map(
        projects.map((project) => [
          this.employeeCreationDomainService.normalizeProjectCode(project.code),
          project,
        ]),
      );

      for (const row of rows) {
        const employeeId = this.getNormalizedString(row, 'employeeId');
        const projectCode = this.getNormalizedString(row, 'projectCode');

        if (employeeId) {
          const existingEmployee = existingEmployeeById.get(employeeId);
          if (existingEmployee) {
            this.addError(row, {
              code: existingEmployee.deletedAt
                ? 'EMPLOYEE_ID_PREVIOUSLY_USED'
                : 'EMPLOYEE_ID_ALREADY_EXISTS',
              field: 'employeeId',
              message: existingEmployee.deletedAt
                ? 'Employee ID was previously used by a deleted employee in this company'
                : 'Employee ID already exists in this company',
            });
          }
        }

        if (projectCode) {
          const project = projectByCode.get(projectCode);
          if (!project || project.deletedAt) {
            this.addError(row, {
              code: 'PROJECT_CODE_NOT_FOUND',
              field: 'projectCode',
              message: 'Project Code does not identify an existing project in this company',
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
              : 'Employees import validation failed',
        },
      });
      throw error;
    }
  }

  async getEmployeesPreview(input: ValidateEmployeesBatchInput) {
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

    if (batch.importType !== ImportType.EMPLOYEES) {
      this.fail(
        'INVALID_TEMPLATE_TYPE',
        'This preview service supports Employees imports only',
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
  ): ValidatedEmployeeRow {
    const employeeId = this.employeeCreationDomainService.normalizeEmployeeId(
      this.text(source.employeeId),
    );
    const employeeName = this.text(source.employeeName).trim();
    const phone = this.text(source.phone).trim();
    const email = this.text(source.email).trim();
    const projectCode = this.employeeCreationDomainService.normalizeProjectCode(
      this.text(source.projectCode),
    );
    const jobTitle = this.text(source.jobTitle).trim() || 'Operator';

    const row: ValidatedEmployeeRow = {
      id,
      rowNumber,
      normalizedData: {
        employeeId,
        employeeName,
        phone,
        email,
        projectCode,
        jobTitle,
        status: 'ON_DUTY',
      },
      computedData: {
        status: 'ON_DUTY',
        linkedUserStatus: 'NOT_LINKED',
      },
      errors: [],
      warnings: [],
      isValid: false,
    };

    if (!employeeId) {
      this.addError(row, {
        code: 'EMPTY_EMPLOYEE_ID',
        field: 'employeeId',
        message: 'Employee ID is required',
      });
    }
    if (!employeeName) {
      this.addError(row, {
        code: 'EMPTY_EMPLOYEE_NAME',
        field: 'employeeName',
        message: 'Employee Name is required',
      });
    }
    if (!projectCode) {
      this.addError(row, {
        code: 'EMPTY_PROJECT_CODE',
        field: 'projectCode',
        message: 'Project Code is required',
      });
    }

    return row;
  }

  private applyDuplicateEmployeeIdErrors(rows: ValidatedEmployeeRow[]) {
    const byEmployeeId = new Map<string, ValidatedEmployeeRow[]>();
    for (const row of rows) {
      const employeeId = this.getNormalizedString(row, 'employeeId');
      if (!employeeId) continue;
      const list = byEmployeeId.get(employeeId) || [];
      list.push(row);
      byEmployeeId.set(employeeId, list);
    }

    for (const duplicateRows of byEmployeeId.values()) {
      if (duplicateRows.length < 2) continue;
      for (const row of duplicateRows) {
        this.addError(row, {
          code: 'DUPLICATE_EMPLOYEE_ID_IN_FILE',
          field: 'employeeId',
          message: 'Employee ID is duplicated in the uploaded file',
        });
      }
    }
  }

  private getNormalizedString(
    row: ValidatedEmployeeRow,
    field: string,
  ) {
    const value = row.normalizedData[field];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private addError(row: ValidatedEmployeeRow, issue: ValidationIssue) {
    if (!row.errors.some((item) => item.code === issue.code && item.field === issue.field)) {
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
