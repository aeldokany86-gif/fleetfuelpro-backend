import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOperationCorrectionDto } from './dto/create-operation-correction.dto';
import { ReviewOperationCorrectionDto } from './dto/review-operation-correction.dto';

type RequestLike = {
  user?: any;
  headers?: Record<string, any>;
};

type CurrentUserContext = {
  id: string;
  fullName: string;
  role: string;
  companyId: string;
  managedProjectIds: string[];
};

type CorrectionField =
  | 'ASSET_ID'
  | 'SOURCE_STATION_ID'
  | 'DESTINATION_STATION_ID'
  | 'FUELER_ID'
  | 'QUANTITY'
  | 'ODOMETER'
  | 'STATION_COUNTER'
  | 'EXTERNAL_STATION_NAME'
  | 'INVOICE_NUMBER'
  | 'TOTAL_COST_AT_OPERATION'
  | 'NOTES';

@Injectable()
export class OperationCorrectionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateOperationCorrectionDto, request?: RequestLike) {
    const currentUser = await this.resolveCurrentUser(request);
    this.validateRequesterCanCreateCorrection(currentUser);

    const fieldName = this.normalizeCorrectionField(dto.fieldName);
    const reason = String(dto.reason || '').trim();

    if (!reason) {
      throw new BadRequestException('Correction reason is required.');
    }

    if (fieldName === 'TRANSACTION_TYPE' as any) {
      throw new BadRequestException('Transaction type cannot be corrected. Cancel the operation and create a new one.');
    }

    const operation = await this.loadOperation(dto.operationId, currentUser.companyId);

    if (operation.status !== 'COMPLETED') {
      throw new BadRequestException('Only completed operations can be corrected in Phase 1.');
    }

    this.validateFieldAllowedForOperation(fieldName, operation.type);

    const oldValue = this.getOperationFieldValue(operation, fieldName);
    const newValue = await this.normalizeNewValue(fieldName, dto.newValue, operation, currentUser.companyId);

    if (this.valuesEqual(oldValue, newValue)) {
      throw new BadRequestException('New value is the same as the current value.');
    }

    const existingPending = await (this.prisma as any).operationCorrection.findFirst({
      where: {
        operationId: operation.id,
        fieldName,
        status: 'PENDING',
      },
    });

    if (existingPending) {
      throw new BadRequestException('There is already a pending correction for this field.');
    }

    const autoApprove = ['Manager', 'Admin', 'PlatformAdmin'].includes(currentUser.role);

    if (!autoApprove) {
      const correctionId = await this.prisma.$transaction(
        async (tx) => {
          const duplicate = await (tx as any).operationCorrection.findFirst({
            where: { operationId: operation.id, fieldName, status: 'PENDING' },
            select: { id: true },
          });
          if (duplicate) {
            throw new BadRequestException('There is already a pending correction for this field.');
          }

          const created = await (tx as any).operationCorrection.create({
            data: {
              companyId: currentUser.companyId,
              operationId: operation.id,
              fieldName,
              oldValue: this.toJsonValue(oldValue),
              newValue: this.toJsonValue(newValue),
              reason,
              status: 'PENDING',
              requestedByUserId: currentUser.id,
            },
            select: { id: true },
          });

          return created.id;
        },
        { maxWait: 5000, timeout: 15000, isolationLevel: 'Serializable' as any },
      );

      // Keep response hydration outside the interactive transaction so the
      // transaction only contains the race-sensitive write path.
      const correction = await (this.prisma as any).operationCorrection.findUnique({
        where: { id: correctionId },
        include: this.correctionInclude(),
      });

      return {
        ok: true,
        message: 'Operation correction request created and pending manager approval.',
        correction,
      };
    }

    const correctionId = await this.prisma.$transaction(
      async (tx) => {
        const duplicate = await (tx as any).operationCorrection.findFirst({
          where: { operationId: operation.id, fieldName, status: 'PENDING' },
          select: { id: true },
        });
        if (duplicate) {
          throw new BadRequestException('There is already a pending correction for this field.');
        }

        const created = await (tx as any).operationCorrection.create({
          data: {
            companyId: currentUser.companyId,
            operationId: operation.id,
            fieldName,
            oldValue: this.toJsonValue(oldValue),
            newValue: this.toJsonValue(newValue),
            reason,
            status: 'APPLIED',
            requestedByUserId: currentUser.id,
            reviewedByUserId: currentUser.id,
            reviewNote: 'Auto-approved by authorized user.',
            reviewedAt: new Date(),
            appliedAt: new Date(),
          },
          select: { id: true },
        });

        await this.applyCorrection(
          tx,
          {
            id: created.id,
            fieldName,
            newValue: this.toJsonValue(newValue),
            operation,
          },
          currentUser,
        );

        return created.id;
      },
      { maxWait: 5000, timeout: 15000, isolationLevel: 'Serializable' as any },
    );

    // The relation-heavy response query is intentionally outside the
    // transaction. This removes one database round trip from the 5-second
    // transaction window without weakening atomic correction application.
    const correction = await (this.prisma as any).operationCorrection.findUnique({
      where: { id: correctionId },
      include: this.correctionInclude(),
    });

    return {
      ok: true,
      message: 'Operation correction applied successfully.',
      correction,
    };
  }

  async getCorrectionContext(operationId: string, request?: RequestLike) {
    const currentUser = await this.resolveCurrentUser(request);
    this.validateRequesterCanCreateCorrection(currentUser);

    const operation = await this.loadOperation(
      operationId,
      currentUser.companyId,
    );

    if (operation.status !== 'COMPLETED') {
      throw new BadRequestException(
        'Only completed operations can be corrected.',
      );
    }

    this.assertCanAccessCorrectionContext(currentUser, operation);

    const operationTime = this.getOperationEffectiveTime(operation);
    const assetProjectId = operation.projectIdAtOperation || null;
    const sourceProjectId =
      operation.sourceProjectIdAtOperation ||
      operation.projectIdAtOperation ||
      null;
    const destinationProjectId =
      operation.destinationProjectIdAtOperation ||
      operation.projectIdAtOperation ||
      null;

    const stationProjectIds = Array.from(
      new Set(
        [sourceProjectId, destinationProjectId].filter(Boolean) as string[],
      ),
    );

    const operationProjectIds = Array.from(
      new Set(
        [assetProjectId, ...stationProjectIds].filter(Boolean) as string[],
      ),
    );

    /*
      Phase 1: collect only candidate entity IDs.

      An entity can belong to the historical project either because:
      1) its current project still matches, or
      2) it has an assignment into that project on/before the operation date.

      This avoids loading every assignment-history row in the company.
    */
    const [
      currentProjectAssets,
      assetAssignmentsToProject,
      currentProjectStations,
      stationAssignmentsToProjects,
      fuelers,
    ] = await Promise.all([
      assetProjectId
        ? (this.prisma as any).asset.findMany({
            where: {
              companyId: currentUser.companyId,
              projectId: assetProjectId,
              createdAt: { lte: operationTime },
              OR: [
                { deletedAt: null },
                { deletedAt: { gt: operationTime } },
              ],
            },
            select: { id: true },
          })
        : Promise.resolve([]),
      assetProjectId
        ? (this.prisma as any).assetAssignmentHistory.findMany({
            where: {
              companyId: currentUser.companyId,
              toProjectId: assetProjectId,
              assignedAt: { lte: operationTime },
            },
            select: { assetId: true },
            distinct: ['assetId'],
          })
        : Promise.resolve([]),
      stationProjectIds.length
        ? (this.prisma as any).station.findMany({
            where: {
              companyId: currentUser.companyId,
              projectId: { in: stationProjectIds },
              createdAt: { lte: operationTime },
              OR: [
                { deletedAt: null },
                { deletedAt: { gt: operationTime } },
              ],
            },
            select: { id: true },
          })
        : Promise.resolve([]),
      stationProjectIds.length
        ? (this.prisma as any).stationAssignmentHistory.findMany({
            where: {
              companyId: currentUser.companyId,
              toProjectId: { in: stationProjectIds },
              assignedAt: { lte: operationTime },
            },
            select: { stationId: true },
            distinct: ['stationId'],
          })
        : Promise.resolve([]),
      (this.prisma as any).employee.findMany({
        where: {
          companyId: currentUser.companyId,
          deletedAt: null,
          linkedUserId: { not: null },
          linkedUser: {
            companyId: currentUser.companyId,
            isActive: true,
          },
          // EmployeeStatus enum contains ON_DUTY, VACATION and
          // RETIRED_RESIGNED. User activation is checked on linkedUser.
          status: 'ON_DUTY',
          ...(operationProjectIds.length
            ? {
                OR: [
                  { projectId: { in: operationProjectIds } },
                  { projectId: null },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          employeeId: true,
          name: true,
          jobTitle: true,
          status: true,
          projectId: true,
          linkedUserId: true,
        },
        orderBy: [{ name: 'asc' }, { employeeId: 'asc' }],
      }),
    ]);

    const assetCandidateIds = Array.from(
      new Set(
        [
          ...currentProjectAssets.map((item: any) => item.id),
          ...assetAssignmentsToProject.map((item: any) => item.assetId),
          operation.assetId,
        ].filter(Boolean) as string[],
      ),
    );

    const stationCandidateIds = Array.from(
      new Set(
        [
          ...currentProjectStations.map((item: any) => item.id),
          ...stationAssignmentsToProjects.map(
            (item: any) => item.stationId,
          ),
          operation.sourceStationId,
          operation.destinationStationId,
        ].filter(Boolean) as string[],
      ),
    );

    /*
      Phase 2: hydrate only candidate entities and fetch their history in
      two batch queries. No findFirst-inside-loop / N+1 queries.
    */
    const [assets, assetAssignments, stations, stationAssignments] =
      await Promise.all([
        assetCandidateIds.length
          ? (this.prisma as any).asset.findMany({
              where: {
                id: { in: assetCandidateIds },
                companyId: currentUser.companyId,
                createdAt: { lte: operationTime },
                OR: [
                  { deletedAt: null },
                  { deletedAt: { gt: operationTime } },
                ],
              },
              select: {
                id: true,
                assetId: true,
                type: true,
                category: true,
                status: true,
                projectId: true,
                createdAt: true,
              },
              orderBy: [{ assetId: 'asc' }, { createdAt: 'asc' }],
            })
          : Promise.resolve([]),
        assetCandidateIds.length
          ? (this.prisma as any).assetAssignmentHistory.findMany({
              where: {
                companyId: currentUser.companyId,
                assetId: { in: assetCandidateIds },
                assignedAt: { lte: operationTime },
              },
              select: {
                assetId: true,
                toProjectId: true,
                assignedAt: true,
                createdAt: true,
                id: true,
              },
              orderBy: [
                { assignedAt: 'desc' },
                { createdAt: 'desc' },
                { id: 'desc' },
              ],
            })
          : Promise.resolve([]),
        stationCandidateIds.length
          ? (this.prisma as any).station.findMany({
              where: {
                id: { in: stationCandidateIds },
                companyId: currentUser.companyId,
                createdAt: { lte: operationTime },
                OR: [
                  { deletedAt: null },
                  { deletedAt: { gt: operationTime } },
                ],
              },
              select: {
                id: true,
                stationId: true,
                name: true,
                status: true,
                projectId: true,
                createdAt: true,
              },
              orderBy: [{ stationId: 'asc' }, { createdAt: 'asc' }],
            })
          : Promise.resolve([]),
        stationCandidateIds.length
          ? (this.prisma as any).stationAssignmentHistory.findMany({
              where: {
                companyId: currentUser.companyId,
                stationId: { in: stationCandidateIds },
                assignedAt: { lte: operationTime },
              },
              select: {
                stationId: true,
                toProjectId: true,
                assignedAt: true,
                createdAt: true,
                id: true,
              },
              orderBy: [
                { assignedAt: 'desc' },
                { createdAt: 'desc' },
                { id: 'desc' },
              ],
            })
          : Promise.resolve([]),
      ]);

    const latestAssetProject = new Map<string, string | null>();
    for (const assignment of assetAssignments) {
      if (!latestAssetProject.has(assignment.assetId)) {
        latestAssetProject.set(
          assignment.assetId,
          assignment.toProjectId || null,
        );
      }
    }

    const latestStationProject = new Map<string, string | null>();
    for (const assignment of stationAssignments) {
      if (!latestStationProject.has(assignment.stationId)) {
        latestStationProject.set(
          assignment.stationId,
          assignment.toProjectId || null,
        );
      }
    }

    const allowedAssets = assetProjectId
      ? assets
          .filter((asset: any) => {
            const status = String(asset.status || '')
              .trim()
              .toLowerCase();
            const historicalProjectId =
              latestAssetProject.get(asset.id) ??
              asset.projectId ??
              null;

            return (
              status !== 'retired' &&
              historicalProjectId === assetProjectId
            );
          })
          .map((asset: any) => ({
            ...asset,
            backendId: asset.id,
            projectIdAtOperation: assetProjectId,
          }))
      : [];

    const mapAllowedStations = (requiredProjectId: string | null) => {
      if (!requiredProjectId) return [];

      return stations
        .filter((station: any) => {
          const identifiers = [
            station.id,
            station.stationId,
            station.name,
          ].map((value) =>
            String(value || '')
              .trim()
              .toLowerCase()
              .replace(/[\s_-]+/g, ''),
          );
          const historicalProjectId =
            latestStationProject.get(station.id) ??
            station.projectId ??
            null;

          return (
            !identifiers.includes('externalsupply') &&
            historicalProjectId === requiredProjectId
          );
        })
        .map((station: any) => ({
          ...station,
          backendId: station.id,
          projectIdAtOperation: requiredProjectId,
        }));
    };

    const allowedFuelers = fuelers.map((fueler: any) => ({
      ...fueler,
      fullName: fueler.name || fueler.employeeId || '-',
      role: fueler.jobTitle || 'Operator',
      backendId: fueler.id,
      employeeBackendId: fueler.id,
    }));

    return {
      ok: true,
      operationContext: {
        operationId: operation.id,
        operationNo: operation.operationNo || null,
        operationType: operation.type,
        operationDate: operationTime,
        projectIdAtOperation: assetProjectId,
        projectNameAtOperation:
          operation.projectNameAtOperation || null,
        sourceProjectIdAtOperation: sourceProjectId,
        sourceProjectNameAtOperation:
          operation.sourceProjectNameAtOperation || null,
        destinationProjectIdAtOperation: destinationProjectId,
        destinationProjectNameAtOperation:
          operation.destinationProjectNameAtOperation || null,
      },
      allowedAssets,
      allowedSourceStations: mapAllowedStations(sourceProjectId),
      allowedDestinationStations: mapAllowedStations(
        destinationProjectId,
      ),
      allowedFuelers,
    };
  }

  async getOdometerCorrectionHistoryReport(filters: {
    companyId?: string;
    projectId?: string;
    assetId?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const companyId = String(filters.companyId || '').trim();

    if (!companyId) {
      throw new BadRequestException('Company ID is required.');
    }

    const parseReportDate = (
      value: string | undefined,
      fieldName: string,
      endOfDay = false,
    ) => {
      const raw = String(value || '').trim();
      if (!raw) return undefined;

      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
      const parsed = new Date(
        dateOnly
          ? `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`
          : raw,
      );

      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException(`Invalid ${fieldName}.`);
      }

      return parsed;
    };

    const dateFrom = parseReportDate(filters.dateFrom, 'dateFrom');
    const dateTo = parseReportDate(filters.dateTo, 'dateTo', true);

    if (dateFrom && dateTo && dateFrom.getTime() > dateTo.getTime()) {
      throw new BadRequestException('Date From cannot be later than Date To.');
    }

    const history = await (this.prisma as any).operationCorrection.findMany({
      where: {
        companyId,
        fieldName: 'ODOMETER',
        status: 'APPLIED',
        ...(dateFrom || dateTo
          ? {
              appliedAt: {
                ...(dateFrom ? { gte: dateFrom } : {}),
                ...(dateTo ? { lte: dateTo } : {}),
              },
            }
          : {}),
        operation: {
          ...(filters.assetId ? { assetId: filters.assetId } : {}),
          ...(filters.projectId
            ? {
                projectIdAtOperation: filters.projectId,
              }
            : {}),
        },
      },
      select: {
        id: true,
        companyId: true,
        operationId: true,
        oldValue: true,
        newValue: true,
        reason: true,
        status: true,
        createdAt: true,
        reviewedAt: true,
        appliedAt: true,
        requestedByUserId: true,
        reviewedByUserId: true,
        requestedBy: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
        reviewedBy: {
          select: {
            id: true,
            fullName: true,
            email: true,
          },
        },
        operation: {
          select: {
            id: true,
            operationNo: true,
            type: true,
            status: true,
            createdAt: true,
            odometer: true,
            lifetimeOdometer: true,
            assetMeterCycleNumber: true,
            assetId: true,
            projectIdAtOperation: true,
            projectNameAtOperation: true,
            sourceProjectIdAtOperation: true,
            sourceProjectNameAtOperation: true,
            destinationProjectIdAtOperation: true,
            destinationProjectNameAtOperation: true,
            asset: {
              select: {
                id: true,
                assetId: true,
                type: true,
                category: true,
                projectId: true,
                project: {
                  select: {
                    id: true,
                    code: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [
        { appliedAt: 'desc' },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
    });

    return history.map((correction: any) => {
      const operation = correction.operation;
      const asset = operation?.asset;
      const performedBy = correction.reviewedBy || correction.requestedBy;

      return {
        id: correction.id,
        eventType: 'CORRECTION',
        eventSource: 'OPERATION_CORRECTION',
        eventDate:
          correction.appliedAt ||
          correction.reviewedAt ||
          correction.createdAt,
        createdAt: correction.createdAt,
        companyId: correction.companyId,
        operationBackendId: operation?.id || correction.operationId,
        operationNo: operation?.operationNo || '-',
        assetBackendId: asset?.id || operation?.assetId || null,
        assetId: asset?.assetId || operation?.assetId || '-',
        assetType: asset?.type || null,
        category: asset?.category || null,
        projectId: operation?.projectIdAtOperation || null,
        projectCode: null,
        projectName: operation?.projectNameAtOperation || null,
        previousReading: Number(this.fromJsonValue(correction.oldValue)),
        currentReading: Number(this.fromJsonValue(correction.newValue)),
        lifetimeReading:
          operation?.lifetimeOdometer == null
            ? null
            : Number(operation.lifetimeOdometer),
        meterCycle:
          operation?.assetMeterCycleNumber == null
            ? null
            : Number(operation.assetMeterCycleNumber),
        reason: correction.reason || 'Operation odometer correction',
        reference: correction.id,
        status: correction.status,
        performedByUserId: performedBy?.id || null,
        performedBy: performedBy?.fullName || performedBy?.email || '-',
        performedByEmail: performedBy?.email || null,
      };
    });
  }

  async findPending(request?: RequestLike) {
    const currentUser = await this.resolveCurrentUser(request);

    if (!['Manager', 'Admin', 'PlatformAdmin'].includes(currentUser.role)) {
      throw new ForbiddenException('Only managers can view pending operation corrections.');
    }

    return (this.prisma as any).operationCorrection.findMany({
      where: {
        companyId: currentUser.companyId,
        status: 'PENDING',
        ...(currentUser.role === 'Manager'
          ? {
              operation: {
                OR: [
                  { projectIdAtOperation: { in: currentUser.managedProjectIds } },
                  { sourceProjectIdAtOperation: { in: currentUser.managedProjectIds } },
                  { destinationProjectIdAtOperation: { in: currentUser.managedProjectIds } },
                ],
              },
            }
          : {}),
      },
      include: this.correctionInclude(),
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async findByOperation(operationId: string, request?: RequestLike) {
    const currentUser = await this.resolveCurrentUser(request);
    await this.loadOperation(operationId, currentUser.companyId);

    return (this.prisma as any).operationCorrection.findMany({
      where: {
        operationId,
        companyId: currentUser.companyId,
      },
      include: this.correctionInclude(),
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async review(correctionId: string, dto: ReviewOperationCorrectionDto, request?: RequestLike) {
    const currentUser = await this.resolveCurrentUser(request);

    if (!['Manager', 'Admin', 'PlatformAdmin'].includes(currentUser.role)) {
      throw new ForbiddenException('Only managers can review operation corrections.');
    }

    const action = String(dto.action || '').trim().toUpperCase();

    if (!['APPROVE', 'REJECT'].includes(action)) {
      throw new BadRequestException('Review action must be APPROVE or REJECT.');
    }

    const correction = await (this.prisma as any).operationCorrection.findFirst({
      where: {
        id: correctionId,
        companyId: currentUser.companyId,
      },
      include: {
        operation: {
          include: {
            sourceStation: true,
            destinationStation: true,
            asset: true,
          },
        },
      },
    });

    if (!correction) {
      throw new NotFoundException('Operation correction request was not found.');
    }

    this.assertCanReviewOperation(currentUser, correction.operation);

    if (correction.status !== 'PENDING') {
      throw new BadRequestException(`Correction cannot be reviewed because it is already ${correction.status}.`);
    }

    if (action === 'REJECT') {
      const claimed = await (this.prisma as any).operationCorrection.updateMany({
        where: { id: correction.id, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          reviewedByUserId: currentUser.id,
          reviewNote: dto.note || null,
          reviewedAt: new Date(),
          rejectedAt: new Date(),
        },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('Correction was already reviewed by another request.');
      }
      const rejected = await (this.prisma as any).operationCorrection.findUnique({
        where: { id: correction.id },
        include: this.correctionInclude(),
      });

      return {
        ok: true,
        message: 'Operation correction rejected.',
        correction: rejected,
      };
    }

    await this.prisma.$transaction(
      async (tx) => {
        const claimed = await (tx as any).operationCorrection.updateMany({
          where: { id: correction.id, status: 'PENDING' },
          data: {
            status: 'APPROVED',
            reviewedByUserId: currentUser.id,
            reviewNote: dto.note || null,
            reviewedAt: new Date(),
          },
        });
        if (claimed.count !== 1) {
          throw new BadRequestException('Correction was already reviewed by another request.');
        }

        await this.applyCorrection(tx, correction, currentUser);

        await (tx as any).operationCorrection.update({
          where: { id: correction.id },
          data: { status: 'APPLIED', appliedAt: new Date() },
        });
      },
      { maxWait: 5000, timeout: 15000 },
    );

    // Fetch the response after commit; relation hydration is not part of the
    // atomic state change and should not consume transaction time.
    const result = await (this.prisma as any).operationCorrection.findUnique({
      where: { id: correction.id },
      include: this.correctionInclude(),
    });

    return {
      ok: true,
      message: 'Operation correction approved and applied successfully.',
      correction: result,
    };
  }

  private async applyCorrection(tx: any, correction: any, currentUser: CurrentUserContext) {
    const operation = correction.operation;
    const fieldName = correction.fieldName as CorrectionField;
    const newValue = this.fromJsonValue(correction.newValue);

    if (operation.status !== 'COMPLETED') {
      throw new BadRequestException('Only completed operations can be corrected.');
    }

    if (fieldName === 'ASSET_ID') {
      await this.applyAssetCorrection(tx, operation, String(newValue), currentUser);
      return;
    }

    if (fieldName === 'SOURCE_STATION_ID') {
      await this.applySourceStationCorrection(tx, operation, String(newValue), currentUser);
      return;
    }

    if (fieldName === 'DESTINATION_STATION_ID') {
      await this.applyDestinationStationCorrection(tx, operation, String(newValue), currentUser);
      return;
    }

    if (fieldName === 'FUELER_ID') {
      await this.applyFuelerCorrection(tx, operation, String(newValue));
      return;
    }

    if (fieldName === 'QUANTITY') {
      await this.applyQuantityCorrection(tx, operation, Number(newValue), currentUser);
      return;
    }

    if (fieldName === 'ODOMETER') {
      await this.applyOdometerCorrection(tx, operation, Number(newValue));
      return;
    }

    if (fieldName === 'STATION_COUNTER') {
      await this.applyStationCounterCorrection(tx, operation, Number(newValue));
      return;
    }

    if (fieldName === 'TOTAL_COST_AT_OPERATION') {
      await (tx as any).operation.update({
        where: { id: operation.id },
        data: {
          totalCostAtOperation: Number(newValue),
          pricePerLiterAtOperation: null,
          fuelPriceHistoryId: null,
          basePricePerLiterAtOperation: null,
          transportCostPerLiterAtOperation: null,
          vatRateAtOperation: null,
          vatAmountPerLiterAtOperation: null,
          grossPricePerLiterAtOperation: null,
          grossTotalCostAtOperation: null,
        },
      });
      return;
    }

    const data: Record<string, any> = {};

    if (fieldName === 'EXTERNAL_STATION_NAME') data.externalStationName = String(newValue || '').trim() || null;
    if (fieldName === 'INVOICE_NUMBER') data.invoiceNumber = String(newValue || '').trim() || null;
    if (fieldName === 'NOTES') data.notes = String(newValue || '').trim() || null;

    await (tx as any).operation.update({
      where: { id: operation.id },
      data,
    });
  }

  private async applyAssetCorrection(tx: any, operation: any, newAssetId: string, currentUser: CurrentUserContext) {
    if (!['DIRECT_REFUEL', 'EXTERNAL_DIRECT_REFUEL'].includes(operation.type)) {
      throw new BadRequestException('Asset correction is allowed only for refuel operations.');
    }

    const oldAssetId = operation.assetId;
    const newAsset = await tx.asset.findFirst({
      where: {
        id: newAssetId,
        companyId: operation.companyId,
        deletedAt: null,
      },
    });

    if (!newAsset) throw new NotFoundException('New asset was not found.');

    const targetProjectId = this.getHistoricalProjectForCorrection(operation, 'ASSET_ID');
    const newAssetProjectId = await this.getAssetProjectAtOperationTime(
      tx,
      newAsset,
      this.getOperationEffectiveTime(operation),
    );

    this.assertEntityMatchesHistoricalProject(
      'Asset',
      newAssetProjectId,
      targetProjectId,
    );

    await this.validateCorrectedProjectRules(tx, operation, {
      sourceProjectId: operation.sourceProjectIdAtOperation || operation.projectIdAtOperation,
      destinationProjectId: operation.destinationProjectIdAtOperation || operation.projectIdAtOperation,
      assetProjectId: targetProjectId,
    });

    /*
      Do not update newAsset.currentOdometer here.
      Asset current odometer is a derived/current-state value and may already include
      later operations after this corrected operation. Correction should only relink
      the operation to the correct asset; odometer recalculation must be handled by a
      separate rebuild/recalculate job if needed.
    */

    await tx.operation.update({
      where: { id: operation.id },
      data: { assetId: newAsset.id },
    });

    if (oldAssetId) await this.rebuildAssetLifetimeHistory(tx, oldAssetId);
    if (newAsset.id !== oldAssetId) {
      await this.rebuildAssetLifetimeHistory(tx, newAsset.id);
    }
  }

  private async applySourceStationCorrection(tx: any, operation: any, newStationId: string, currentUser: CurrentUserContext) {
    if (!['DIRECT_REFUEL', 'INTERNAL_TRANSFER', 'EXTERNAL_TRANSFER'].includes(operation.type)) {
      throw new BadRequestException('Source station correction is not allowed for this operation type.');
    }

    // The operation was loaded with its source station before the transaction.
    // Reuse it instead of spending another transaction query on the same row.
    const oldStation = operation.sourceStation || null;
    const newStation = await tx.station.findFirst({ where: { id: newStationId, companyId: operation.companyId, deletedAt: null } });

    if (!newStation) throw new NotFoundException('New source station was not found.');

    const targetProjectId = this.getHistoricalProjectForCorrection(operation, 'SOURCE_STATION_ID');
    const newStationProjectId = await this.getStationProjectAtOperationTime(
      tx,
      newStation,
      this.getOperationEffectiveTime(operation),
    );

    this.assertEntityMatchesHistoricalProject(
      'Source station',
      newStationProjectId,
      targetProjectId,
    );

    await this.validateCorrectedProjectRules(tx, operation, {
      sourceProjectId: targetProjectId,
      destinationProjectId: operation.destinationProjectIdAtOperation || operation.projectIdAtOperation,
      assetProjectId: operation.projectIdAtOperation,
    });

    const quantity = Math.abs(Number(operation.quantity || 0));

    if (oldStation) {
      await this.createStockMovement(tx, {
        station: oldStation,
        operation,
        movementType: 'ADJUSTMENT',
        quantity,
        reason: 'Operation correction: reverse old source station',
        currentUser,
      });
    }

    await this.createStockMovement(tx, {
      station: newStation,
      operation,
      movementType: 'ADJUSTMENT',
      quantity: -quantity,
      reason: 'Operation correction: apply new source station',
      currentUser,
    });

    await tx.operation.update({
      where: { id: operation.id },
      data: { sourceStationId: newStation.id },
    });

    if (operation.stationCounter != null && this.counterUsesSourceStation(operation.type)) {
      if (oldStation?.id) await this.rebuildStationLifetimeHistory(tx, oldStation.id);
      if (newStation.id !== oldStation?.id) {
        await this.rebuildStationLifetimeHistory(tx, newStation.id);
      }
    }
  }

  private async applyDestinationStationCorrection(tx: any, operation: any, newStationId: string, currentUser: CurrentUserContext) {
    if (!['INTERNAL_TRANSFER', 'EXTERNAL_SUPPLY', 'EXTERNAL_TRANSFER'].includes(operation.type)) {
      throw new BadRequestException('Destination station correction is not allowed for this operation type.');
    }

    // The operation was loaded with its destination station before the
    // transaction, so no additional lookup is required here.
    const oldStation = operation.destinationStation || null;
    const newStation = await tx.station.findFirst({ where: { id: newStationId, companyId: operation.companyId, deletedAt: null } });

    if (!newStation) throw new NotFoundException('New destination station was not found.');

    const targetProjectId = this.getHistoricalProjectForCorrection(operation, 'DESTINATION_STATION_ID');
    const newStationProjectId = await this.getStationProjectAtOperationTime(
      tx,
      newStation,
      this.getOperationEffectiveTime(operation),
    );

    this.assertEntityMatchesHistoricalProject(
      'Destination station',
      newStationProjectId,
      targetProjectId,
    );

    await this.validateCorrectedProjectRules(tx, operation, {
      sourceProjectId: operation.sourceProjectIdAtOperation || operation.projectIdAtOperation,
      destinationProjectId: targetProjectId,
      assetProjectId: operation.projectIdAtOperation,
    });

    const quantity = Math.abs(Number(operation.quantity || 0));

    if (oldStation) {
      await this.createStockMovement(tx, {
        station: oldStation,
        operation,
        movementType: 'ADJUSTMENT',
        quantity: -quantity,
        reason: 'Operation correction: reverse old destination station',
        currentUser,
      });
    }

    await this.createStockMovement(tx, {
      station: newStation,
      operation,
      movementType: 'ADJUSTMENT',
      quantity,
      reason: 'Operation correction: apply new destination station',
      currentUser,
    });

    await tx.operation.update({
      where: { id: operation.id },
      data: { destinationStationId: newStation.id },
    });

    if (operation.stationCounter != null && operation.type === 'EXTERNAL_SUPPLY') {
      if (oldStation?.id) await this.rebuildStationLifetimeHistory(tx, oldStation.id);
      if (newStation.id !== oldStation?.id) {
        await this.rebuildStationLifetimeHistory(tx, newStation.id);
      }
    }
  }

  private async applyFuelerCorrection(
    tx: any,
    operation: any,
    newRequestedByUserId: string,
  ) {
    const fueler = await (tx as any).employee.findFirst({
      where: {
        linkedUserId: newRequestedByUserId,
        companyId: operation.companyId,
        deletedAt: null,
      },
      select: {
        id: true,
        status: true,
        projectId: true,
        linkedUserId: true,
        linkedUser: {
          select: {
            id: true,
            companyId: true,
            isActive: true,
          },
        },
      },
    });

    if (!fueler) {
      throw new NotFoundException(
        'Fueler linked to the selected system user was not found.',
      );
    }

    const normalizedStatus = String(fueler.status || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '');

    if (!['onduty', 'active'].includes(normalizedStatus)) {
      throw new BadRequestException(
        'Selected fueler must be active or on duty.',
      );
    }

    if (!fueler.linkedUserId || !fueler.linkedUser) {
      throw new BadRequestException(
        'Selected fueler must be linked to a system user.',
      );
    }

    if (fueler.linkedUser.companyId !== operation.companyId) {
      throw new BadRequestException(
        'Selected fueler user must belong to the operation company.',
      );
    }

    if (fueler.linkedUser.isActive === false) {
      throw new BadRequestException(
        'Selected fueler user must be active.',
      );
    }

    const operationProjectIds = [
      operation.sourceStation?.projectId,
      operation.destinationStation?.projectId,
      operation.asset?.projectId,
    ].filter(Boolean);

    if (
      fueler.projectId &&
      operationProjectIds.length > 0 &&
      !operationProjectIds.includes(fueler.projectId)
    ) {
      throw new BadRequestException(
        'Selected fueler must belong to one of the operation projects.',
      );
    }

    await (tx as any).operation.update({
      where: { id: operation.id },
      data: {
        requestedByUserId: fueler.linkedUserId,
      },
    });
  }

  private async applyQuantityCorrection(tx: any, operation: any, newQuantity: number, currentUser: CurrentUserContext) {
    if (!newQuantity || Number(newQuantity) <= 0) {
      throw new BadRequestException('New quantity must be greater than zero.');
    }

    const oldQuantity = Number(operation.quantity || 0);
    const diff = Number(newQuantity) - oldQuantity;

    if (diff === 0) return;

    if (operation.type === 'DIRECT_REFUEL') {
      const sourceStation = operation.sourceStation;
      await this.createStockMovement(tx, {
        station: sourceStation,
        operation,
        movementType: 'ADJUSTMENT',
        quantity: -diff,
        reason: 'Operation correction: quantity change for Direct Refuel',
        currentUser,
      });
    }

    if (operation.type === 'INTERNAL_TRANSFER' || operation.type === 'EXTERNAL_TRANSFER') {
      const sourceStation = operation.sourceStation;
      const destinationStation = operation.destinationStation;

      await this.createStockMovement(tx, {
        station: sourceStation,
        operation,
        movementType: 'ADJUSTMENT',
        quantity: -diff,
        reason: 'Operation correction: quantity change for transfer source',
        currentUser,
      });

      await this.createStockMovement(tx, {
        station: destinationStation,
        operation,
        movementType: 'ADJUSTMENT',
        quantity: diff,
        reason: 'Operation correction: quantity change for transfer destination',
        currentUser,
      });
    }

    if (operation.type === 'EXTERNAL_SUPPLY') {
      const destinationStation = operation.destinationStation;

      await this.createStockMovement(tx, {
        station: destinationStation,
        operation,
        movementType: 'ADJUSTMENT',
        quantity: diff,
        reason: 'Operation correction: quantity change for External Supply',
        currentUser,
      });
    }

    const pricePerLiter = Number(operation.pricePerLiterAtOperation || 0);
    const nextTotalCost = pricePerLiter > 0 ? Number(newQuantity) * pricePerLiter : operation.totalCostAtOperation;
    const grossPricePerLiter = Number(
      operation.grossPricePerLiterAtOperation || 0,
    );
    const nextGrossTotalCost =
      grossPricePerLiter > 0
        ? Number(newQuantity) * grossPricePerLiter
        : operation.grossTotalCostAtOperation;

    await tx.operation.update({
      where: { id: operation.id },
      data: {
        quantity: Number(newQuantity),
        totalCostAtOperation: nextTotalCost,
        grossTotalCostAtOperation: nextGrossTotalCost,
      },
    });
  }

  private async applyOdometerCorrection(
    tx: any,
    operation: any,
    newOdometer: number,
  ) {
    if (!['DIRECT_REFUEL', 'EXTERNAL_DIRECT_REFUEL'].includes(operation.type)) {
      throw new BadRequestException(
        'Odometer correction is allowed only for refuel operations.',
      );
    }

    if (!operation.assetId) {
      throw new BadRequestException(
        'Operation asset is required for odometer correction.',
      );
    }

    if (!operation.asset) {
      throw new NotFoundException('Asset was not found.');
    }

    const normalizedOdometer = Number(newOdometer);

    if (!Number.isFinite(normalizedOdometer) || normalizedOdometer < 0) {
      throw new BadRequestException(
        'Odometer must be a valid non-negative number.',
      );
    }

    await this.validateCorrectedOdometerSequence(
      tx,
      operation,
      normalizedOdometer,
    );

    await tx.operation.update({
      where: { id: operation.id },
      data: { odometer: normalizedOdometer },
    });

    await this.rebuildAssetLifetimeHistory(tx, operation.assetId);
  }

  private async validateCorrectedOdometerSequence(
    tx: any,
    operation: any,
    newOdometer: number,
  ) {
    const [operations, resets] = await Promise.all([
      tx.operation.findMany({
        where: {
          assetId: operation.assetId,
          status: 'COMPLETED',
          odometer: { not: null },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          operationNo: true,
          odometer: true,
          createdAt: true,
        },
      }),
      tx.assetOdometerReset.findMany({
        where: {
          assetId: operation.assetId,
        },
        orderBy: [{ effectiveAt: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          newOdometer: true,
          effectiveAt: true,
          createdAt: true,
        },
      }),
    ]);

    const events = [
      ...operations.map((item: any) => ({
        kind: 'OPERATION' as const,
        at: item.createdAt,
        createdAt: item.createdAt,
        item,
      })),
      ...resets.map((item: any) => ({
        kind: 'RESET' as const,
        at: item.effectiveAt,
        createdAt: item.createdAt,
        item,
      })),
    ].sort((a, b) => {
      const effectiveTime =
        new Date(a.at).getTime() - new Date(b.at).getTime();

      if (effectiveTime !== 0) {
        return effectiveTime;
      }

      const createdTime =
        new Date(a.createdAt).getTime() -
        new Date(b.createdAt).getTime();

      if (createdTime !== 0) {
        return createdTime;
      }

      return a.kind === 'RESET' ? -1 : 1;
    });

    const targetIndex = events.findIndex(
      (event) =>
        event.kind === 'OPERATION' &&
        event.item.id === operation.id,
    );

    if (targetIndex < 0) {
      throw new NotFoundException(
        'Operation was not found in the completed odometer history.',
      );
    }

    let cycleStartReading: number | null = null;
    let previousOperation: any = null;

    for (let index = targetIndex - 1; index >= 0; index -= 1) {
      const event = events[index];

      if (event.kind === 'RESET') {
        cycleStartReading = Number(event.item.newOdometer || 0);
        break;
      }

      if (!previousOperation) {
        previousOperation = event.item;
      }
    }

    let nextOperation: any = null;

    for (let index = targetIndex + 1; index < events.length; index += 1) {
      const event = events[index];

      if (event.kind === 'RESET') {
        break;
      }

      if (event.kind === 'OPERATION') {
        nextOperation = event.item;
        break;
      }
    }

    const lowerBounds: Array<{
      value: number;
      label: string;
    }> = [];

    if (cycleStartReading !== null) {
      lowerBounds.push({
        value: cycleStartReading,
        label: `meter-cycle start reading (${cycleStartReading})`,
      });
    }

    if (previousOperation) {
      const previousReading = Number(previousOperation.odometer);

      lowerBounds.push({
        value: previousReading,
        label: `previous operation ${
          previousOperation.operationNo || previousOperation.id
        } reading (${previousReading})`,
      });
    }

    const strongestLowerBound = lowerBounds.sort(
      (a, b) => b.value - a.value,
    )[0];

    if (
      strongestLowerBound &&
      newOdometer < strongestLowerBound.value
    ) {
      throw new BadRequestException(
        `Corrected odometer (${newOdometer}) cannot be lower than the ${strongestLowerBound.label}.`,
      );
    }

    if (nextOperation) {
      const nextReading = Number(nextOperation.odometer);

      if (newOdometer > nextReading) {
        throw new BadRequestException(
          `Corrected odometer (${newOdometer}) cannot be higher than the next operation ${
            nextOperation.operationNo || nextOperation.id
          } reading (${nextReading}) in the same meter cycle.`,
        );
      }
    }
  }

  private async applyStationCounterCorrection(tx: any, operation: any, newCounter: number) {
    if (Number(newCounter) < 0) throw new BadRequestException('Station counter cannot be negative.');

    const stationId = this.getOperationCounterStationId(operation);
    if (!stationId) {
      throw new BadRequestException('This operation type does not use an internal station counter.');
    }

    await tx.operation.update({
      where: { id: operation.id },
      data: { stationCounter: Number(newCounter) },
    });

    await this.rebuildStationLifetimeHistory(tx, stationId);
  }


  private getEffectiveAssetLifetime(asset: any) {
    const storedLifetime = Number(asset?.currentLifetimeOdometer || 0);
    const currentReading = Number(asset?.currentOdometer || 0);
    const currentCycle = Number(asset?.currentMeterCycle || 1);
    if (currentCycle === 1 && storedLifetime === 0 && currentReading > 0) {
      return currentReading;
    }
    return storedLifetime;
  }

  private getEffectiveStationLifetime(station: any) {
    const storedLifetime = Number(station?.currentLifetimeCounter || 0);
    const currentReading = Number(station?.currentCounter || 0);
    const currentCycle = Number(station?.currentCounterCycle || 1);
    if (currentCycle === 1 && storedLifetime === 0 && currentReading > 0) {
      return currentReading;
    }
    return storedLifetime;
  }

  private counterUsesSourceStation(type: string) {
    return ['DIRECT_REFUEL', 'INTERNAL_TRANSFER', 'EXTERNAL_TRANSFER'].includes(type);
  }

  private getOperationCounterStationId(operation: any) {
    if (this.counterUsesSourceStation(operation.type)) {
      return operation.sourceStationId || operation.sourceStation?.id || null;
    }
    if (operation.type === 'EXTERNAL_SUPPLY') {
      return operation.destinationStationId || operation.destinationStation?.id || null;
    }
    return null;
  }

  private operationUsesStationCounter(operation: any, stationId: string) {
    return this.getOperationCounterStationId(operation) === stationId;
  }

  private async rebuildAssetLifetimeHistory(tx: any, assetId: string) {
    const asset = await tx.asset.findUnique({ where: { id: assetId } });
    if (!asset) throw new NotFoundException('Asset was not found.');

    const [operations, resets] = await Promise.all([
      tx.operation.findMany({
        where: { assetId, status: 'COMPLETED', odometer: { not: null } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, odometer: true, createdAt: true },
      }),
      tx.assetOdometerReset.findMany({
        where: { assetId },
        orderBy: [{ effectiveAt: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, newOdometer: true, effectiveAt: true, createdAt: true },
      }),
    ]);

    const events = [
      ...operations.map((item: any) => ({ kind: 'OPERATION' as const, at: item.createdAt, item })),
      ...resets.map((item: any) => ({ kind: 'RESET' as const, at: item.effectiveAt, item })),
    ].sort((a, b) => {
      const diff = new Date(a.at).getTime() - new Date(b.at).getTime();
      if (diff !== 0) return diff;
      return a.kind === 'RESET' ? -1 : 1;
    });

    let cycle = 1;
    let cycleStart = 0;
    let lifetimeAtStart = 0;
    let latestReading = 0;
    let latestLifetime = 0;
    let previousReadingInCycle: number | null = null;

    for (const event of events) {
      if (event.kind === 'RESET') {
        const oldCycle = cycle;
        cycle += 1;
        await tx.assetOdometerReset.update({
          where: { id: event.item.id },
          data: {
            lifetimeAtReset: latestLifetime,
            oldMeterCycle: oldCycle,
            newMeterCycle: cycle,
          },
        });
        cycleStart = Number(event.item.newOdometer || 0);
        lifetimeAtStart = latestLifetime;
        latestReading = cycleStart;
        previousReadingInCycle = cycleStart;
        continue;
      }

      const reading = Number(event.item.odometer || 0);

      if (!Number.isFinite(reading) || reading < 0) {
        throw new BadRequestException(
          'Historical operation contains an invalid odometer reading.',
        );
      }

      if (reading < cycleStart) {
        throw new BadRequestException(
          `Odometer cannot be lower than cycle start reading (${cycleStart}).`,
        );
      }

      if (
        previousReadingInCycle !== null &&
        reading < previousReadingInCycle
      ) {
        throw new BadRequestException(
          `Operation odometer (${reading}) cannot be lower than the previous reading (${previousReadingInCycle}) in meter cycle ${cycle}.`,
        );
      }

      previousReadingInCycle = reading;
      latestReading = reading;
      latestLifetime = lifetimeAtStart + (reading - cycleStart);
      await tx.operation.update({
        where: { id: event.item.id },
        data: { lifetimeOdometer: latestLifetime, assetMeterCycleNumber: cycle },
      });
    }

    if (events.length === 0) {
      latestReading = Number(asset.currentOdometer || 0);
      latestLifetime = this.getEffectiveAssetLifetime(asset);
      cycle = Number(asset.currentMeterCycle || 1);
    }

    await tx.asset.update({
      where: { id: assetId },
      data: {
        currentOdometer: latestReading,
        currentLifetimeOdometer: latestLifetime,
        currentMeterCycle: cycle,
      },
    });
  }

  private async rebuildStationLifetimeHistory(tx: any, stationId: string) {
    const station = await tx.station.findUnique({ where: { id: stationId } });
    if (!station) throw new NotFoundException('Station was not found.');

    const [candidateOperations, resets] = await Promise.all([
      tx.operation.findMany({
        where: {
          status: 'COMPLETED',
          stationCounter: { not: null },
          OR: [{ sourceStationId: stationId }, { destinationStationId: stationId }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          type: true,
          sourceStationId: true,
          destinationStationId: true,
          stationCounter: true,
          createdAt: true,
        },
      }),
      tx.stationCounterReset.findMany({
        where: { stationId },
        orderBy: [{ effectiveAt: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, newCounter: true, effectiveAt: true, createdAt: true },
      }),
    ]);

    const operations = candidateOperations.filter((item: any) =>
      this.operationUsesStationCounter(item, stationId),
    );
    const events = [
      ...operations.map((item: any) => ({ kind: 'OPERATION' as const, at: item.createdAt, item })),
      ...resets.map((item: any) => ({ kind: 'RESET' as const, at: item.effectiveAt, item })),
    ].sort((a, b) => {
      const diff = new Date(a.at).getTime() - new Date(b.at).getTime();
      if (diff !== 0) return diff;
      return a.kind === 'RESET' ? -1 : 1;
    });

    let cycle = 1;
    let cycleStart = 0;
    let lifetimeAtStart = 0;
    let latestReading = 0;
    let latestLifetime = 0;

    for (const event of events) {
      if (event.kind === 'RESET') {
        const oldCycle = cycle;
        cycle += 1;
        await tx.stationCounterReset.update({
          where: { id: event.item.id },
          data: {
            lifetimeAtReset: latestLifetime,
            oldCounterCycle: oldCycle,
            newCounterCycle: cycle,
          },
        });
        cycleStart = Number(event.item.newCounter || 0);
        lifetimeAtStart = latestLifetime;
        latestReading = cycleStart;
        continue;
      }

      const reading = Number(event.item.stationCounter || 0);
      if (reading < cycleStart) {
        throw new BadRequestException(
          `Station counter cannot be lower than cycle start reading (${cycleStart}).`,
        );
      }
      latestReading = reading;
      latestLifetime = lifetimeAtStart + (reading - cycleStart);
      await tx.operation.update({
        where: { id: event.item.id },
        data: { lifetimeCounter: latestLifetime, stationCounterCycleNumber: cycle },
      });
    }

    if (events.length === 0) {
      latestReading = Number(station.currentCounter || 0);
      latestLifetime = this.getEffectiveStationLifetime(station);
      cycle = Number(station.currentCounterCycle || 1);
    }

    await tx.station.update({
      where: { id: stationId },
      data: {
        currentCounter: latestReading,
        currentLifetimeCounter: latestLifetime,
        currentCounterCycle: cycle,
      },
    });
  }

  private async createStockMovement(
    tx: any,
    args: {
      station: any;
      operation: any;
      movementType: string;
      quantity: number;
      reason: string;
      currentUser: CurrentUserContext;
    },
  ) {
    const { station, operation, movementType, quantity, reason, currentUser } = args;
    if (!station) throw new BadRequestException('Station is required for stock movement correction.');

    const movementQuantity = Number(quantity || 0);
    const updatedStation = await tx.station.update({
      where: { id: station.id },
      data: { currentStock: { increment: movementQuantity } },
      select: { currentStock: true },
    });
    const balanceAfter = Number(updatedStation.currentStock || 0);
    const balanceBefore = balanceAfter - movementQuantity;

    await tx.stationStockMovement.create({
      data: {
        stationId: station.id,
        companyId: operation.companyId,
        movementType,
        quantity: movementQuantity,
        balanceBefore,
        balanceAfter,
        referenceType: 'OperationCorrection',
        referenceId: operation.id,
        reason,
        createdByUserId: currentUser.id,
      },
    });
  }

  private getOperationEffectiveTime(operation: any): Date {
    const value = operation.completedAt || operation.approvedAt || operation.createdAt;
    const parsed = value ? new Date(value) : new Date();

    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('Operation historical date is invalid.');
    }

    return parsed;
  }

  private getHistoricalProjectForCorrection(
    operation: any,
    fieldName: CorrectionField,
  ): string {
    let projectId: string | null = operation.projectIdAtOperation || null;

    if (fieldName === 'SOURCE_STATION_ID') {
      projectId =
        operation.sourceProjectIdAtOperation ||
        operation.projectIdAtOperation ||
        null;
    }

    if (fieldName === 'DESTINATION_STATION_ID') {
      projectId =
        operation.destinationProjectIdAtOperation ||
        operation.projectIdAtOperation ||
        null;
    }

    if (!projectId) {
      throw new BadRequestException(
        'Operation historical project snapshot is missing. Rebuild the operation snapshot before correction.',
      );
    }

    return projectId;
  }

  private assertEntityMatchesHistoricalProject(
    entityLabel: string,
    entityProjectId: string | null,
    requiredProjectId: string,
  ) {
    if (!entityProjectId || entityProjectId !== requiredProjectId) {
      throw new BadRequestException(
        `${entityLabel} must belong to the operation historical project at the operation date.`,
      );
    }
  }

  private async getAssetProjectAtOperationTime(
    db: any,
    asset: any,
    operationTime: Date,
  ): Promise<string | null> {
    if (asset.createdAt && new Date(asset.createdAt).getTime() > operationTime.getTime()) {
      return null;
    }

    const latestAssignment = await db.assetAssignmentHistory.findFirst({
      where: {
        assetId: asset.id,
        companyId: asset.companyId,
        assignedAt: { lte: operationTime },
      },
      select: { toProjectId: true },
      orderBy: [{ assignedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });

    return latestAssignment?.toProjectId || asset.projectId || null;
  }

  private async getStationProjectAtOperationTime(
    db: any,
    station: any,
    operationTime: Date,
  ): Promise<string | null> {
    if (station.createdAt && new Date(station.createdAt).getTime() > operationTime.getTime()) {
      return null;
    }

    const latestAssignment = await db.stationAssignmentHistory.findFirst({
      where: {
        stationId: station.id,
        companyId: station.companyId,
        assignedAt: { lte: operationTime },
      },
      select: { toProjectId: true },
      orderBy: [{ assignedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });

    return latestAssignment?.toProjectId || station.projectId || null;
  }

  private async validateCorrectedProjectRules(
    _tx: any,
    operation: any,
    projects: {
      sourceProjectId?: string | null;
      destinationProjectId?: string | null;
      assetProjectId?: string | null;
    },
  ) {
    if (operation.type === 'DIRECT_REFUEL') {
      if (!projects.sourceProjectId || !projects.assetProjectId || projects.sourceProjectId !== projects.assetProjectId) {
        throw new BadRequestException('Direct Refuel requires the source station and asset to be in the same project.');
      }
    }
    if (operation.type === 'INTERNAL_TRANSFER') {
      if (!projects.sourceProjectId || !projects.destinationProjectId || projects.sourceProjectId !== projects.destinationProjectId) {
        throw new BadRequestException('Internal Transfer requires both stations to be in the same project.');
      }
    }
    if (operation.type === 'EXTERNAL_TRANSFER') {
      if (!projects.sourceProjectId || !projects.destinationProjectId || projects.sourceProjectId === projects.destinationProjectId) {
        throw new BadRequestException('External Transfer requires stations in different projects.');
      }
    }
  }

  private assertCanReviewOperation(user: CurrentUserContext, operation: any) {
    if (user.role !== 'Manager') return;
    const projectIds = [
      operation.projectIdAtOperation,
      operation.sourceProjectIdAtOperation,
      operation.destinationProjectIdAtOperation,
    ].filter(Boolean);
    if (!projectIds.some((id: string) => user.managedProjectIds.includes(id))) {
      throw new ForbiddenException('Manager can review corrections for managed projects only.');
    }
  }

  private assertCanAccessCorrectionContext(
    user: CurrentUserContext,
    operation: any,
  ) {
    if (user.role !== 'Manager') return;

    const projectIds = [
      operation.projectIdAtOperation,
      operation.sourceProjectIdAtOperation,
      operation.destinationProjectIdAtOperation,
    ].filter(Boolean);

    if (
      !projectIds.some((projectId: string) =>
        user.managedProjectIds.includes(projectId),
      )
    ) {
      throw new ForbiddenException(
        'Manager can correct operations for managed projects only.',
      );
    }
  }

  private validateRequesterCanCreateCorrection(user: CurrentUserContext) {
    if (!['Supervisor', 'Manager', 'Admin', 'PlatformAdmin'].includes(user.role)) {
      throw new ForbiddenException('This role cannot request operation corrections.');
    }
  }

  private validateFieldAllowedForOperation(fieldName: CorrectionField, type: string) {
    if (fieldName === 'ASSET_ID' && !['DIRECT_REFUEL', 'EXTERNAL_DIRECT_REFUEL'].includes(type)) {
      throw new BadRequestException('assetId correction is allowed only for refuel operations.');
    }

    if (fieldName === 'SOURCE_STATION_ID' && !['DIRECT_REFUEL', 'INTERNAL_TRANSFER', 'EXTERNAL_TRANSFER'].includes(type)) {
      throw new BadRequestException('sourceStationId correction is not allowed for this operation type.');
    }

    if (fieldName === 'DESTINATION_STATION_ID' && !['INTERNAL_TRANSFER', 'EXTERNAL_SUPPLY', 'EXTERNAL_TRANSFER'].includes(type)) {
      throw new BadRequestException('destinationStationId correction is not allowed for this operation type.');
    }

    if (fieldName === 'ODOMETER' && !['DIRECT_REFUEL', 'EXTERNAL_DIRECT_REFUEL'].includes(type)) {
      throw new BadRequestException('odometer correction is allowed only for refuel operations.');
    }

    if (fieldName === 'TOTAL_COST_AT_OPERATION' && type !== 'EXTERNAL_DIRECT_REFUEL') {
      throw new BadRequestException('Invoice amount correction is allowed only for External Direct Refuel.');
    }
  }

  private async normalizeNewValue(fieldName: CorrectionField, value: any, operation: any, companyId: string) {
    if (fieldName === 'QUANTITY' || fieldName === 'ODOMETER' || fieldName === 'STATION_COUNTER' || fieldName === 'TOTAL_COST_AT_OPERATION') {
      const num = Number(value);
      if (Number.isNaN(num)) throw new BadRequestException(`${fieldName} must be a number.`);
      if ((fieldName === 'QUANTITY' || fieldName === 'TOTAL_COST_AT_OPERATION') && num <= 0) {
        throw new BadRequestException(`${fieldName} must be greater than zero.`);
      }

      // Reject invalid quantity corrections at request creation time, before the
      // correction reaches the manager approval stage.
      if (fieldName === 'QUANTITY') {
        await this.validateQuantityCorrectionBeforeRequest(operation, num, companyId);
      }

      return num;
    }

    if (fieldName === 'ASSET_ID') {
      const asset = await (this.prisma as any).asset.findFirst({
        where: { id: String(value), companyId, deletedAt: null },
      });
      if (!asset) throw new NotFoundException('New asset was not found.');

      const targetProjectId = this.getHistoricalProjectForCorrection(operation, 'ASSET_ID');
      const assetProjectId = await this.getAssetProjectAtOperationTime(
        this.prisma as any,
        asset,
        this.getOperationEffectiveTime(operation),
      );
      this.assertEntityMatchesHistoricalProject('Asset', assetProjectId, targetProjectId);

      return asset.id;
    }

    if (fieldName === 'SOURCE_STATION_ID' || fieldName === 'DESTINATION_STATION_ID') {
      const station = await (this.prisma as any).station.findFirst({
        where: { id: String(value), companyId, deletedAt: null },
      });
      if (!station) throw new NotFoundException('New station was not found.');

      const targetProjectId = this.getHistoricalProjectForCorrection(operation, fieldName);
      const stationProjectId = await this.getStationProjectAtOperationTime(
        this.prisma as any,
        station,
        this.getOperationEffectiveTime(operation),
      );
      this.assertEntityMatchesHistoricalProject(
        fieldName === 'SOURCE_STATION_ID' ? 'Source station' : 'Destination station',
        stationProjectId,
        targetProjectId,
      );

      return station.id;
    }

    if (fieldName === 'FUELER_ID') {
      const fueler = await (this.prisma as any).employee.findFirst({
        where: {
          id: String(value),
          companyId,
          deletedAt: null,
        },
        select: {
          id: true,
          status: true,
          projectId: true,
          linkedUserId: true,
          linkedUser: {
            select: {
              id: true,
              companyId: true,
              isActive: true,
            },
          },
        },
      });

      if (!fueler) {
        throw new NotFoundException('Fueler was not found.');
      }

      const normalizedStatus = String(fueler.status || '')
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '');

      if (!['onduty', 'active'].includes(normalizedStatus)) {
        throw new BadRequestException(
          'Selected fueler must be active or on duty.',
        );
      }

      if (!fueler.linkedUserId || !fueler.linkedUser) {
        throw new BadRequestException(
          'Selected fueler must be linked to a system user.',
        );
      }

      if (fueler.linkedUser.companyId !== companyId) {
        throw new BadRequestException(
          'Selected fueler user must belong to the operation company.',
        );
      }

      if (fueler.linkedUser.isActive === false) {
        throw new BadRequestException(
          'Selected fueler user must be active.',
        );
      }

      const operationProjectIds = [
        operation.projectIdAtOperation,
        operation.sourceProjectIdAtOperation,
        operation.destinationProjectIdAtOperation,
      ].filter(Boolean);

      if (
        fueler.projectId &&
        operationProjectIds.length > 0 &&
        !operationProjectIds.includes(fueler.projectId)
      ) {
        throw new BadRequestException(
          'Selected fueler must belong to one of the operation projects.',
        );
      }

      // Operation stores the executing person in requestedByUserId.
      // The correction payload starts with an Employee ID, so normalize it
      // to the linked system User ID before persisting the correction.
      return fueler.linkedUserId;
    }

    return String(value ?? '').trim();
  }

  private async validateQuantityCorrectionBeforeRequest(
    operation: any,
    newQuantity: number,
    companyId: string,
  ) {
    if (!['DIRECT_REFUEL', 'EXTERNAL_DIRECT_REFUEL'].includes(operation.type)) {
      return;
    }

    if (!operation.assetId) {
      throw new BadRequestException('Operation asset is required for quantity correction.');
    }

    const asset =
      operation.asset ||
      (await (this.prisma as any).asset.findFirst({
        where: {
          id: operation.assetId,
          companyId,
          deletedAt: null,
        },
      }));

    if (!asset) {
      throw new NotFoundException('Operation asset was not found.');
    }

    const tankCapacity = Number(asset.fuelTankCapacity || 0);

    if (tankCapacity > 0 && Number(newQuantity) > tankCapacity) {
      throw new BadRequestException(
        `Quantity cannot exceed asset fuel tank capacity (${tankCapacity} L).`,
      );
    }
  }

  private getOperationFieldValue(operation: any, fieldName: CorrectionField) {
    const map: Record<CorrectionField, any> = {
      ASSET_ID: operation.assetId,
      SOURCE_STATION_ID: operation.sourceStationId,
      DESTINATION_STATION_ID: operation.destinationStationId,
      FUELER_ID: operation.requestedByUserId,
      QUANTITY: operation.quantity,
      ODOMETER: operation.odometer,
      STATION_COUNTER: operation.stationCounter,
      EXTERNAL_STATION_NAME: operation.externalStationName,
      INVOICE_NUMBER: operation.invoiceNumber,
      TOTAL_COST_AT_OPERATION: operation.totalCostAtOperation,
      NOTES: operation.notes,
    };

    return map[fieldName];
  }

  private async loadOperation(operationId: string, companyId: string) {
    const operation = await (this.prisma as any).operation.findFirst({
      where: { id: operationId, companyId },
      include: {
        sourceStation: true,
        destinationStation: true,
        asset: true,
      },
    });

    if (!operation) throw new NotFoundException('Operation was not found.');
    return operation;
  }

  private async resolveCurrentUser(request?: RequestLike): Promise<CurrentUserContext> {
    const requestUser = request?.user as any;

    const userId =
      requestUser?.id ||
      this.getHeader(request, 'x-user-id');

    if (!userId) {
      throw new UnauthorizedException('Current user was not found.');
    }

    const dbUser = await (this.prisma as any).user.findUnique({
      where: { id: userId },
      include: {
        role: true,
        managedProjects: { where: { deletedAt: null, isActive: true }, select: { id: true } },
      },
    });

    if (!dbUser) {
      throw new UnauthorizedException('Real database user is required.');
    }

    return {
      id: dbUser.id,
      fullName: dbUser.fullName || dbUser.email || 'User',
      role: this.normalizeRole(dbUser.role?.name),
      companyId: dbUser.companyId,
      managedProjectIds: dbUser.managedProjects.map((project: any) => project.id),
    };
  }

  private normalizeRole(value: any) {
    const compact = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');

    if (compact === 'platformuser' || compact === 'platformadmin') return 'PlatformAdmin';
    if (compact === 'topmanagement') return 'TopManagement';
    if (compact === 'admin') return 'Admin';
    if (compact === 'manager') return 'Manager';
    if (compact === 'supervisor') return 'Supervisor';
    if (compact === 'officer') return 'Officer';
    if (compact === 'operator') return 'Operator';

    throw new ForbiddenException(`Unsupported role: ${value}`);
  }

  private normalizeCorrectionField(value: any): CorrectionField {
    const compact = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');

    const aliases: Record<string, CorrectionField> = {
      ASSET: 'ASSET_ID',
      ASSET_ID: 'ASSET_ID',
      ASSETID: 'ASSET_ID',
      SOURCE_STATION: 'SOURCE_STATION_ID',
      SOURCE_STATION_ID: 'SOURCE_STATION_ID',
      SOURCESTATIONID: 'SOURCE_STATION_ID',
      DESTINATION_STATION: 'DESTINATION_STATION_ID',
      DESTINATION_STATION_ID: 'DESTINATION_STATION_ID',
      DESTINATIONSTATIONID: 'DESTINATION_STATION_ID',
      FUELER: 'FUELER_ID',
      FUELER_ID: 'FUELER_ID',
      FUELERID: 'FUELER_ID',
      OPERATOR: 'FUELER_ID',
      OPERATOR_ID: 'FUELER_ID',
      OPERATORID: 'FUELER_ID',
      QUANTITY: 'QUANTITY',
      DIESEL_QUANTITY: 'QUANTITY',
      ODOMETER: 'ODOMETER',
      HOUR_METER: 'ODOMETER',
      STATION_COUNTER: 'STATION_COUNTER',
      STATIONCOUNTER: 'STATION_COUNTER',
      EXTERNAL_STATION_NAME: 'EXTERNAL_STATION_NAME',
      EXTERNALSTATIONNAME: 'EXTERNAL_STATION_NAME',
      INVOICE_NUMBER: 'INVOICE_NUMBER',
      INVOICENUMBER: 'INVOICE_NUMBER',
      INVOICE_AMOUNT: 'TOTAL_COST_AT_OPERATION',
      INVOICEAMOUNT: 'TOTAL_COST_AT_OPERATION',
      TOTAL_COST: 'TOTAL_COST_AT_OPERATION',
      TOTAL_COST_AT_OPERATION: 'TOTAL_COST_AT_OPERATION',
      TOTALCOSTATOPERATION: 'TOTAL_COST_AT_OPERATION',
      NOTES: 'NOTES',
    };

    const field = aliases[compact];
    if (!field) throw new BadRequestException(`Unsupported correction field: ${value}`);
    return field;
  }

  private correctionInclude() {
    return {
      operation: {
        select: {
          id: true,
          operationNo: true,
          type: true,
          status: true,
        },
      },
      requestedBy: {
        select: { id: true, fullName: true },
      },
      reviewedBy: {
        select: { id: true, fullName: true },
      },
    };
  }

  private getHeader(request: RequestLike | undefined, name: string) {
    const value = request?.headers?.[name] || request?.headers?.[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  private valuesEqual(a: any, b: any) {
    return JSON.stringify(this.toJsonValue(a)) === JSON.stringify(this.toJsonValue(b));
  }

  private toJsonValue(value: any) {
    if (value === undefined) return null;
    return value;
  }

  private fromJsonValue(value: any) {
    return value === undefined ? null : value;
  }
}
