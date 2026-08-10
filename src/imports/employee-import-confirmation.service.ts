import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  EmployeeStatus,
  ImportBatchStatus,
  ImportType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmployeeCreationDomainService } from '../employees/employee-creation-domain.service';
import { ImportsService } from './imports.service';

type ConfirmEmployeesBatchInput = {
  batchId: string;
  actorUserId: string;
  actorRoleName: string;
  actorCompanyId: string;
};

type JsonRecord = Record<string, unknown>;

@Injectable()
export class EmployeeImportConfirmationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importsService: ImportsService,
    private readonly employeeCreationDomainService: EmployeeCreationDomainService,
  ) {}

  async confirmEmployeesBatch(input: ConfirmEmployeesBatchInput) {
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

    if (batch.importType !== ImportType.EMPLOYEES) {
      this.fail(
        'INVALID_TEMPLATE_TYPE',
        'This confirmation service supports Employees imports only',
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
      const employeeId = this.requiredString(data.employeeId);
      const employeeName = this.requiredString(data.employeeName);
      const projectCode = this.requiredString(data.projectCode);
      const projectId = this.requiredString(data.projectId);

      if (!employeeId || !employeeName || !projectCode || !projectId) {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `Validated snapshot is incomplete at Excel row ${row.rowNumber}`,
        );
      }

      if (this.requiredString(data.status) !== 'ON_DUTY') {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `Validated employee status is invalid at Excel row ${row.rowNumber}`,
        );
      }

      return {
        rowNumber: row.rowNumber,
        employeeId: this.employeeCreationDomainService.normalizeEmployeeId(employeeId),
        employeeName,
        phone: this.optionalString(data.phone),
        email: this.optionalString(data.email),
        projectCode: this.employeeCreationDomainService.normalizeProjectCode(projectCode),
        projectId,
        jobTitle: this.optionalString(data.jobTitle) || 'Operator',
      };
    });

    const employeeIds = preparedRows.map((row) => row.employeeId);
    if (new Set(employeeIds).size !== employeeIds.length) {
      this.fail(
        'DUPLICATE_EMPLOYEE_ID_IN_FILE',
        'Validated snapshot contains duplicate Employee IDs',
      );
    }

    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
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

          const [existingEmployees, projects] = await Promise.all([
            tx.employee.findMany({
              where: {
                companyId: batch.companyId,
                employeeId: { in: employeeIds, mode: 'insensitive' },
              },
              select: { employeeId: true, deletedAt: true },
            }),
            tx.project.findMany({
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

          if (existingEmployees.length > 0) {
            const existing = existingEmployees[0];
            const code = this.employeeCreationDomainService.normalizeEmployeeId(
              existing.employeeId,
            );
            this.fail(
              existing.deletedAt
                ? 'EMPLOYEE_ID_PREVIOUSLY_USED'
                : 'EMPLOYEE_ID_ALREADY_EXISTS',
              existing.deletedAt
                ? `Employee ID ${code} was previously used by a deleted employee`
                : `Employee ID ${code} already exists`,
            );
          }

          const projectsById = new Map(projects.map((project) => [project.id, project]));
          for (const row of preparedRows) {
            const project = projectsById.get(row.projectId);
            if (!project || project.deletedAt || !project.isActive) {
              this.fail(
                'PROJECT_NOT_AVAILABLE',
                `Project Code ${row.projectCode} is no longer an active project`,
              );
            }
            if (
              this.employeeCreationDomainService.normalizeProjectCode(project.code) !==
              row.projectCode
            ) {
              this.fail(
                'BATCH_SNAPSHOT_INVALID',
                `Project snapshot changed for Excel row ${row.rowNumber}`,
              );
            }
          }

          const createdEmployees: Array<{
            id: string;
            employeeId: string;
            name: string;
            rowNumber: number;
          }> = [];

          for (const row of preparedRows) {
            const employee = await this.employeeCreationDomainService.createEmployee(
              tx,
              {
                companyId: batch.companyId,
                employeeId: row.employeeId,
                name: row.employeeName,
                phone: row.phone,
                email: row.email,
                projectId: row.projectId,
                linkedUserId: null,
                jobTitle: row.jobTitle,
                status: EmployeeStatus.ON_DUTY,
                createdById: context.actor.id,
              },
            );

            createdEmployees.push({
              id: employee.id,
              employeeId: employee.employeeId,
              name: employee.name,
              rowNumber: row.rowNumber,
            });
          }

          const completedBatch = await tx.importBatch.update({
            where: { id: batch.id },
            data: {
              status: ImportBatchStatus.COMPLETED,
              importedRows: createdEmployees.length,
              failedRows: 0,
              completedAt: new Date(),
            },
          });

          return { batch: completedBatch, employees: createdEmployees };
        },
        { maxWait: 10_000, timeout: 120_000 },
      );

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
          failureCode: this.errorCode(error) || 'IMPORT_FAILED',
          failureMessage:
            error instanceof Error ? error.message : 'Employees import failed',
        },
      });
      throw error;
    }
  }

  private requiredString(value: unknown) {
    return typeof value === 'string' ? value.trim() : '';
  }

  private optionalString(value: unknown) {
    const text = this.requiredString(value);
    return text || null;
  }

  private asObject(value: unknown): JsonRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as JsonRecord;
  }

  private errorCode(error: unknown) {
    const response = (error as any)?.getResponse?.();
    return response && typeof response === 'object' ? response.code : null;
  }

  private fail(code: string, message: string): never {
    throw new BadRequestException({ code, message });
  }
}
