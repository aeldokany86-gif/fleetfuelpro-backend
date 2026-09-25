import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ImportBatchStatus,
  ImportType,
  StationStatus,
  StationStructureType,
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
      const structureType = this.parseStructureType(data.structureType);
      const parentStationCode = this.optionalString(data.parentStationId);
      const projectCode = this.requiredString(data.projectCode);
      const projectId = this.requiredString(data.projectId);
      const capacity = this.optionalNumber(data.capacity);
      const openingBalance = this.optionalNumber(data.openingBalance);
      const openingCounter = this.optionalNumber(data.openingCounter);

      if (!stationId || !structureType || !projectCode || !projectId) {
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

      if (
        capacity !== null &&
        (!Number.isFinite(capacity) || capacity < 0)
      ) {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `Validated capacity is invalid at Excel row ${row.rowNumber}`,
        );
      }

      if (
        openingBalance !== null &&
        (!Number.isFinite(openingBalance) || openingBalance < 0)
      ) {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `Validated opening balance is invalid at Excel row ${row.rowNumber}`,
        );
      }

      if (
        openingCounter !== null &&
        (!Number.isFinite(openingCounter) || openingCounter < 0)
      ) {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `Validated opening counter is invalid at Excel row ${row.rowNumber}`,
        );
      }

      if (
        structureType === StationStructureType.STANDALONE &&
        (openingBalance === null || openingCounter === null || parentStationCode)
      ) {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `STANDALONE snapshot is invalid at Excel row ${row.rowNumber}`,
        );
      }

      if (
        structureType === StationStructureType.SHARED_TANK &&
        (
          openingBalance === null ||
          parentStationCode ||
          (openingCounter !== null && openingCounter !== 0)
        )
      ) {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `SHARED_TANK snapshot is invalid at Excel row ${row.rowNumber}`,
        );
      }

      if (
        structureType === StationStructureType.DISPENSER &&
        (
          !parentStationCode ||
          openingCounter === null ||
          (openingBalance !== null && openingBalance !== 0) ||
          (capacity !== null && capacity !== 0)
        )
      ) {
        this.fail(
          'BATCH_SNAPSHOT_INVALID',
          `DISPENSER snapshot is invalid at Excel row ${row.rowNumber}`,
        );
      }

      return {
        rowNumber: row.rowNumber,
        stationId:
          this.stationCreationDomainService.normalizeStationId(stationId),
        stationName: this.optionalString(data.stationName),
        stationType: this.optionalString(data.stationType),
        structureType,
        parentStationCode: parentStationCode
          ? this.stationCreationDomainService.normalizeStationId(
              parentStationCode,
            )
          : null,
        capacity,
        projectCode:
          this.stationCreationDomainService.normalizeProjectCode(projectCode),
        projectId,
        openingBalance:
          structureType === StationStructureType.DISPENSER
            ? 0
            : openingBalance ?? 0,
        openingCounter:
          structureType === StationStructureType.SHARED_TANK
            ? 0
            : openingCounter ?? 0,
      };
    });

    const stationIds = preparedRows.map((row) => row.stationId);
    if (new Set(stationIds).size !== stationIds.length) {
      this.fail(
        'DUPLICATE_STATION_ID_IN_FILE',
        'Validated snapshot contains duplicate Station IDs',
      );
    }

    const referencedParentCodes = Array.from(
      new Set(
        preparedRows
          .map((row) => row.parentStationCode)
          .filter((value): value is string => Boolean(value)),
      ),
    );

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

          const lookupCodes = Array.from(
            new Set([...stationIds, ...referencedParentCodes]),
          );

          const [stationLookupRows, projects] = await Promise.all([
            tx.station.findMany({
              where: {
                companyId: batch.companyId,
                stationId: { in: lookupCodes, mode: 'insensitive' },
              },
              select: {
                id: true,
                stationId: true,
                structureType: true,
                projectId: true,
                deletedAt: true,
              },
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

          const existingStationByCode = new Map(
            stationLookupRows.map((station) => [
              this.stationCreationDomainService.normalizeStationId(
                station.stationId,
              ),
              station,
            ]),
          );

          for (const stationId of stationIds) {
            const existing = existingStationByCode.get(stationId);
            if (!existing) continue;

            this.fail(
              existing.deletedAt
                ? 'STATION_ID_PREVIOUSLY_USED'
                : 'STATION_ID_ALREADY_EXISTS',
              existing.deletedAt
                ? `Station ID ${stationId} was previously used by a deleted station`
                : `Station ID ${stationId} already exists`,
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
            structureType: StationStructureType;
            parentStationId: string | null;
            rowNumber: number;
          }> = [];

          const availableParentByCode = new Map<
            string,
            {
              id: string;
              stationId: string;
              structureType: StationStructureType;
              projectId: string | null;
            }
          >();

          for (const code of referencedParentCodes) {
            const existing = existingStationByCode.get(code);
            if (!existing || existing.deletedAt) continue;

            availableParentByCode.set(code, {
              id: existing.id,
              stationId: existing.stationId,
              structureType: existing.structureType,
              projectId: existing.projectId,
            });
          }

          const parentAndStandaloneRows = preparedRows.filter(
            (row) => row.structureType !== StationStructureType.DISPENSER,
          );

          for (const row of parentAndStandaloneRows) {
            const station =
              await this.stationCreationDomainService.createStation(tx, {
                companyId: batch.companyId,
                stationId: row.stationId,
                name: row.stationName,
                type: row.stationType,
                structureType: row.structureType,
                parentStationId: null,
                capacity: row.capacity,
                openingBalance: row.openingBalance,
                openingCounter: row.openingCounter,
                projectId: row.projectId,
                status: StationStatus.ACTIVE,
                createdById: context.actor.id,
              });

            createdStations.push({
              id: station.id,
              stationId: station.stationId,
              name: station.name,
              structureType: station.structureType,
              parentStationId: station.parentStationId,
              rowNumber: row.rowNumber,
            });

            if (row.structureType === StationStructureType.SHARED_TANK) {
              availableParentByCode.set(row.stationId, {
                id: station.id,
                stationId: station.stationId,
                structureType: station.structureType,
                projectId: station.projectId,
              });
            }
          }

          const dispenserRows = preparedRows.filter(
            (row) => row.structureType === StationStructureType.DISPENSER,
          );

          for (const row of dispenserRows) {
            const parentCode = row.parentStationCode;
            if (!parentCode) {
              this.fail(
                'BATCH_SNAPSHOT_INVALID',
                `DISPENSER parent is missing at Excel row ${row.rowNumber}`,
              );
            }

            const parent = availableParentByCode.get(parentCode);

            if (!parent) {
              this.fail(
                'PARENT_STATION_NOT_FOUND',
                `Parent Station ID ${parentCode} is no longer available`,
              );
            }

            if (parent.structureType !== StationStructureType.SHARED_TANK) {
              this.fail(
                'PARENT_MUST_BE_SHARED_TANK',
                `Parent Station ID ${parentCode} is not a SHARED_TANK`,
              );
            }

            if ((parent.projectId || null) !== row.projectId) {
              this.fail(
                'PARENT_PROJECT_MISMATCH',
                `DISPENSER ${row.stationId} and parent ${parentCode} must belong to the same project`,
              );
            }

            const station =
              await this.stationCreationDomainService.createStation(tx, {
                companyId: batch.companyId,
                stationId: row.stationId,
                name: row.stationName,
                type: row.stationType,
                structureType: row.structureType,
                parentStationId: parent.id,
                capacity: null,
                openingBalance: 0,
                openingCounter: row.openingCounter,
                projectId: row.projectId,
                status: StationStatus.ACTIVE,
                createdById: context.actor.id,
              });

            createdStations.push({
              id: station.id,
              stationId: station.stationId,
              name: station.name,
              structureType: station.structureType,
              parentStationId: station.parentStationId,
              rowNumber: row.rowNumber,
            });
          }

          createdStations.sort((a, b) => a.rowNumber - b.rowNumber);

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

  private parseStructureType(value: unknown): StationStructureType | null {
    const normalized = String(value ?? '')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');

    if (normalized === StationStructureType.STANDALONE) {
      return StationStructureType.STANDALONE;
    }

    if (normalized === StationStructureType.SHARED_TANK) {
      return StationStructureType.SHARED_TANK;
    }

    if (normalized === StationStructureType.DISPENSER) {
      return StationStructureType.DISPENSER;
    }

    return null;
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
