import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ImportBatchStatus,
  ImportType,
  StationStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StationCreationDomainService } from '../stations/station-creation-domain.service';
import { ImportsService } from './imports.service';

type ConfirmStationsBatchInput = {
  batchId: string;
  actorUserId: string;
  actorRoleName: string;
  actorCompanyId: string;
};

type JsonRecord = Record<string, unknown>;

@Injectable()
export class StationImportConfirmationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importsService: ImportsService,
    private readonly stationCreationDomainService: StationCreationDomainService,
  ) {}

  async confirmStationsBatch(input: ConfirmStationsBatchInput) {
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

    if (batch.importType !== ImportType.STATIONS) {
      this.fail(
        'INVALID_TEMPLATE_TYPE',
        'This confirmation service supports Stations imports only',
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

      const stationId = this.requiredString(data.stationId);
      const projectCode = this.requiredString(data.projectCode);
      const projectId = this.requiredString(data.projectId);
      const openingBalance = this.requiredNumber(data.openingBalance);
      const currentCounter = this.requiredNumber(data.currentCounter);

      if (
        !stationId ||
        !projectCode ||
        !projectId ||
        openingBalance === null ||
        currentCounter === null
      ) {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `Validated snapshot is incomplete at Excel row ${row.rowNumber}`,
        );
      }

      if (this.requiredString(data.status) !== 'ACTIVE') {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `Validated station status is invalid at Excel row ${row.rowNumber}`,
        );
      }

      if (openingBalance < 0 || currentCounter < 0) {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `Validated opening values are invalid at Excel row ${row.rowNumber}`,
        );
      }

      return {
        rowNumber: row.rowNumber,
        stationId:
          this.stationCreationDomainService.normalizeStationId(stationId),
        stationName: this.optionalString(data.stationName),
        stationType: this.optionalString(data.stationType),
        capacity: this.optionalNumber(data.capacity),
        projectCode:
          this.stationCreationDomainService.normalizeProjectCode(projectCode),
        projectId,
        openingBalance,
        currentCounter,
      };
    });

    const stationIds = preparedRows.map((row) => row.stationId);
    if (new Set(stationIds).size !== stationIds.length) {
      this.fail(
        'DUPLICATE_STATION_ID_IN_FILE',
        'Validated snapshot contains duplicate Station IDs',
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

          const [existingStations, projects] = await Promise.all([
            tx.station.findMany({
              where: {
                companyId: batch.companyId,
                stationId: { in: stationIds, mode: 'insensitive' },
              },
              select: { stationId: true, deletedAt: true },
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

          if (existingStations.length > 0) {
            const existing = existingStations[0];
            const code =
              this.stationCreationDomainService.normalizeStationId(
                existing.stationId,
              );

            this.fail(
              existing.deletedAt
                ? 'STATION_ID_PREVIOUSLY_USED'
                : 'STATION_ID_ALREADY_EXISTS',
              existing.deletedAt
                ? `Station ID ${code} was previously used by a deleted station`
                : `Station ID ${code} already exists`,
            );
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
              this.stationCreationDomainService.normalizeProjectCode(
                project.code,
              ) !== row.projectCode
            ) {
              this.fail(
                'BATCH_SNAPSHOT_INVALID',
                `Project snapshot changed for Excel row ${row.rowNumber}`,
              );
            }
          }

          const createdStations: Array<{
            id: string;
            stationId: string;
            name: string | null;
            rowNumber: number;
          }> = [];

          for (const row of preparedRows) {
            const station =
              await this.stationCreationDomainService.createStation(tx, {
                companyId: batch.companyId,
                stationId: row.stationId,
                name: row.stationName,
                type: row.stationType,
                capacity: row.capacity,
                openingBalance: row.openingBalance,
                currentCounter: row.currentCounter,
                projectId: row.projectId,
                status: StationStatus.ACTIVE,
                createdById: context.actor.id,
              });

            createdStations.push({
              id: station.id,
              stationId: station.stationId,
              name: station.name,
              rowNumber: row.rowNumber,
            });
          }

          const completedBatch = await tx.importBatch.update({
            where: { id: batch.id },
            data: {
              status: ImportBatchStatus.COMPLETED,
              importedRows: createdStations.length,
              failedRows: 0,
              completedAt: new Date(),
              failureCode: null,
              failureMessage: null,
              failedAt: null,
            },
          });

          return {
            batch: completedBatch,
            stations: createdStations,
          };
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
          failureCode: 'IMPORT_FAILED',
          failureMessage:
            error instanceof Error
              ? error.message
              : 'Stations import confirmation failed',
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
