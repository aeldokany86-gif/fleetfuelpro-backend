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
import { ProjectCreationDomainService } from '../projects/project-creation-domain.service';
import { ImportsService } from './imports.service';

type ConfirmProjectsBatchInput = {
  batchId: string;
  actorUserId: string;
  actorRoleName: string;
  actorCompanyId: string;
};

type JsonRecord = Record<string, unknown>;

@Injectable()
export class ProjectImportConfirmationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importsService: ImportsService,
    private readonly projectCreationDomainService: ProjectCreationDomainService,
  ) {}

  async confirmProjectsBatch(input: ConfirmProjectsBatchInput) {
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

    const context = await this.importsService.resolveImportContext(
      input.actorUserId,
      input.actorRoleName,
      input.actorCompanyId,
      batch.companyId,
    );

    if (batch.importType !== ImportType.PROJECTS) {
      this.fail(
        'INVALID_TEMPLATE_TYPE',
        'This confirmation endpoint supports Projects imports only',
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
      batch.validRows !== batch.totalRows
    ) {
      this.fail(
        'BATCH_NOT_READY_TO_IMPORT',
        'Import batch contains invalid or unvalidated rows',
      );
    }

    if (
      batch.rows.length !== batch.totalRows ||
      batch.rows.some((row) => !row.isValid || !row.normalizedData)
    ) {
      this.fail(
        'BATCH_SNAPSHOT_INVALID',
        'Validated import snapshot is incomplete',
      );
    }

    const preparedRows = batch.rows.map((row) => {
      const data = this.asObject(row.normalizedData);

      const projectCode = this.requiredString(data.projectCode);
      const projectName = this.requiredString(data.projectName);
      const projectStartDate = this.requiredString(data.projectStartDate);
      const status = this.requiredString(data.status);

      const basePricePerLiter = this.requiredNumber(
        data.basePricePerLiter,
      );
      const transportCostPerLiter = this.requiredNumber(
        data.transportCostPerLiter,
      );
      const vatRate = this.requiredNumber(data.vatRate);

      if (!projectCode || !projectName || !projectStartDate) {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `Validated snapshot is incomplete at Excel row ${row.rowNumber}`,
        );
      }

      if (status !== 'ACTIVE' && status !== 'INACTIVE') {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `Validated project status is invalid at Excel row ${row.rowNumber}`,
        );
      }

      const effectiveFrom = new Date(
        `${projectStartDate}T00:00:00.000Z`,
      );

      if (Number.isNaN(effectiveFrom.getTime())) {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `Validated project start date is invalid at Excel row ${row.rowNumber}`,
        );
      }

      const initialPricing =
        this.projectCreationDomainService.resolveFuelPriceComponents({
          basePricePerLiter,
          transportCostPerLiter,
          vatRate,
        });

      return {
        rowNumber: row.rowNumber,
        projectCode:
          this.projectCreationDomainService.normalizeCode(projectCode),
        projectName,
        location: this.optionalString(data.location),
        description: this.optionalString(data.description),
        isActive: status === 'ACTIVE',
        effectiveFrom,
        initialPricing,
      };
    });

    const normalizedCodes = preparedRows.map((row) => row.projectCode);

    if (new Set(normalizedCodes).size !== normalizedCodes.length) {
      this.fail(
        'DUPLICATE_PROJECT_CODE_IN_FILE',
        'Validated snapshot contains duplicate Project Codes',
      );
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const lockResult = await tx.importBatch.updateMany({
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

        if (lockResult.count !== 1) {
          this.fail(
            'INVALID_BATCH_STATUS',
            'Import batch is no longer ready to import',
          );
        }

        const existingProjects = await tx.project.findMany({
          where: {
            companyId: batch.companyId,
            code: {
              in: normalizedCodes,
              mode: 'insensitive',
            },
          },
          select: {
            code: true,
            deletedAt: true,
          },
        });

        if (existingProjects.length > 0) {
          const existing = existingProjects[0];
          const normalizedExistingCode =
            this.projectCreationDomainService.normalizeCode(existing.code);

          if (existing.deletedAt) {
            this.fail(
              'PROJECT_CODE_PREVIOUSLY_USED',
              `Project Code ${normalizedExistingCode} was previously used by a deleted project`,
            );
          }

          this.fail(
            'PROJECT_CODE_ALREADY_EXISTS',
            `Project Code ${normalizedExistingCode} already exists`,
          );
        }

        const createdProjects: Array<{
          id: string;
          code: string;
          name: string;
          rowNumber: number;
        }> = [];

        for (const row of preparedRows) {
          const project =
            await this.projectCreationDomainService.createProjectWithInitialPrice(
              tx,
              {
                company: {
                  country: context.company.country,
                  currency: context.company.currency,
                },
                companyId: batch.companyId,
                projectCode: row.projectCode,
                name: row.projectName,
                location: row.location || undefined,
                description: row.description || undefined,
                isActive: row.isActive,
                initialPricing: row.initialPricing,
                effectiveFrom: row.effectiveFrom,
                createdByUserId: context.actor.id,
              },
            );

          createdProjects.push({
            id: project.id,
            code: project.code,
            name: project.name,
            rowNumber: row.rowNumber,
          });
        }

        const completedAt = new Date();

        const completedBatch = await tx.importBatch.update({
          where: {
            id: batch.id,
          },
          data: {
            status: ImportBatchStatus.COMPLETED,
            importedRows: createdProjects.length,
            failedRows: 0,
            completedAt,
            failureCode: null,
            failureMessage: null,
            failedAt: null,
          },
          include: {
            company: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
            confirmedBy: {
              select: {
                id: true,
                fullName: true,
                username: true,
              },
            },
          },
        });

        return {
          batch: completedBatch,
          summary: {
            totalRows: completedBatch.totalRows,
            importedRows: completedBatch.importedRows,
            failedRows: completedBatch.failedRows,
          },
          projects: createdProjects,
        };
      }, {
        maxWait: 10_000,
        timeout: 120_000,
      });

      return result;
    } catch (error) {
      if (error instanceof BadRequestException) {
        await this.markBatchFailed(batch.id, error);
        throw error;
      }

      await this.markBatchFailed(batch.id, error);
      throw error;
    }
  }

  private async markBatchFailed(
    batchId: string,
    error: unknown,
  ) {
    const response =
      error instanceof BadRequestException
        ? error.getResponse()
        : null;

    const code =
      typeof response === 'object' &&
      response !== null &&
      'code' in response &&
      typeof response.code === 'string'
        ? response.code
        : 'IMPORT_FAILED';

    const message =
      typeof response === 'object' &&
      response !== null &&
      'message' in response &&
      typeof response.message === 'string'
        ? response.message
        : error instanceof Error
          ? error.message
          : 'Projects import failed';

    await this.prisma.importBatch.updateMany({
      where: {
        id: batchId,
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
        failureCode: code,
        failureMessage: message,
      },
    });
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

  private requiredString(value: unknown) {
    if (typeof value !== 'string') {
      return '';
    }

    return value.trim();
  }

  private optionalString(value: unknown) {
    const text = this.requiredString(value);
    return text || null;
  }

  private requiredNumber(value: unknown) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.fail(
        'BATCH_SNAPSHOT_INVALID',
        'Validated numeric value is missing or invalid',
      );
    }

    return value;
  }

  private fail(code: string, message: string): never {
    throw new BadRequestException({
      code,
      message,
    });
  }
}
