import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { AssetsService } from '../assets/assets.service';
import { EmployeeTransfersService } from '../employee-transfers/employee-transfers.service';
import { OperationCorrectionsService } from '../operation-corrections/operation-corrections.service';
import { OperationsService } from '../operations/operations.service';
import { PrismaService } from '../prisma/prisma.service';
import { StationsService } from '../stations/stations.service';

type JwtUser = {
  userId?: string;
  companyId?: string;
  roleId?: string;
  roleName?: string;
};


type MobileApprovalReviewInput = {
  action: 'APPROVE' | 'REJECT';
  note?: string;
};

type ApprovalInboxItem = {
  id: string;
  approvalId?: string | null;
  type: string;
  module: string;
  status: string;
  approvalStage: string | null;
  reference: string;
  requestedAt: Date | string | null;
  requestedBy: {
    id: string | null;
    name: string | null;
  } | null;
  fromProject: {
    id: string;
    code: string | null;
    name: string | null;
  } | null;
  toProject: {
    id: string;
    code: string | null;
    name: string | null;
  } | null;
  project: {
    id: string;
    code: string | null;
    name: string | null;
  } | null;
  entity: {
    id: string | null;
    code: string | null;
    name: string | null;
    kind: string;
  } | null;
  summary: Record<string, unknown>;
  availableActions: Array<'APPROVE' | 'REJECT'>;
};

@Injectable()
export class MobileApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operationsService: OperationsService,
    private readonly operationCorrectionsService: OperationCorrectionsService,
    private readonly assetsService: AssetsService,
    private readonly stationsService: StationsService,
    private readonly employeeTransfersService: EmployeeTransfersService,
  ) {}

  private normalizeRoleName(roleName: string) {
    return String(roleName || '')
      .trim()
      .toUpperCase()
      .replace(/[\s_-]+/g, '');
  }

  private isAdminRole(roleName: string) {
    const normalized = this.normalizeRoleName(roleName);
    return (
      normalized === 'ADMIN' ||
      normalized === 'PLATFORMADMIN' ||
      normalized === 'PLATFORMUSER'
    );
  }

  private isOperationCorrectionAdminRole(roleName: string) {
    const normalized = this.normalizeRoleName(roleName);
    return normalized === 'ADMIN' || normalized === 'PLATFORMADMIN';
  }

  private isManagerRole(roleName: string) {
    return this.normalizeRoleName(roleName) === 'MANAGER';
  }

  private projectInfo(project: any) {
    if (!project) return null;

    return {
      id: project.id,
      code: project.code ?? null,
      name: project.name ?? null,
    };
  }

  private requestedByInfo(user: any) {
    if (!user) return null;

    return {
      id: user.id ?? null,
      name: user.fullName || user.username || user.email || null,
    };
  }

  private sortItems(items: ApprovalInboxItem[]) {
    return items.sort((a, b) => {
      const aTime = a.requestedAt ? new Date(a.requestedAt).getTime() : 0;
      const bTime = b.requestedAt ? new Date(b.requestedAt).getTime() : 0;
      return bTime - aTime;
    });
  }

  async review(
    rawType: string,
    approvalRequestId: string,
    input: MobileApprovalReviewInput,
    jwtUser?: JwtUser,
  ) {
    const jwtUserId = String(jwtUser?.userId || '').trim();
    const jwtCompanyId = String(jwtUser?.companyId || '').trim();

    if (!jwtUserId || !jwtCompanyId) {
      throw new UnauthorizedException('Authenticated user is required.');
    }

    const currentUser = await (this.prisma as any).user.findFirst({
      where: {
        id: jwtUserId,
        companyId: jwtCompanyId,
        deletedAt: null,
        isActive: true,
      },
      include: {
        role: true,
      },
    });

    if (!currentUser) {
      throw new UnauthorizedException(
        'Authenticated user is invalid or inactive.',
      );
    }

    const type = String(rawType || '')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');

    const requestId = String(approvalRequestId || '').trim();
    if (!requestId) {
      throw new BadRequestException('Approval request ID is required.');
    }

    const approve = input.action === 'APPROVE';
    const note = String(input.note || '').trim() || undefined;
    const reviewerUserId = currentUser.id;

    // OperationsService and OperationCorrectionsService predate the current
    // JwtStrategy shape and resolve request.user.id. Adapt the authenticated
    // JWT identity here without changing either domain service.
    const domainRequest = {
      user: {
        id: reviewerUserId,
        userId: reviewerUserId,
        companyId: currentUser.companyId,
        roleId: currentUser.roleId,
        roleName: currentUser.role?.name || jwtUser?.roleName || '',
        role: currentUser.role?.name || jwtUser?.roleName || '',
        fullName:
          currentUser.fullName ||
          currentUser.username ||
          currentUser.email ||
          reviewerUserId,
        email: currentUser.email || undefined,
      },
    };

    switch (type) {
      case 'EXTERNAL_DIRECT_REFUEL':
      case 'EXTERNAL_SUPPLY':
      case 'EXTERNAL_TRANSFER':
        return this.operationsService.review(
          requestId,
          {
            action: input.action,
            note,
          } as any,
          domainRequest,
        );

      case 'OPERATION_CORRECTION':
        return this.operationCorrectionsService.review(
          requestId,
          {
            action: input.action,
            note,
          } as any,
          domainRequest,
        );

      case 'ASSET_TRANSFER':
        return this.assetsService.reviewTransfer(
          requestId,
          reviewerUserId,
          approve,
          note,
        );

      case 'ASSET_ODOMETER_RESET':
        return this.assetsService.reviewActionRequest(requestId, {
          reviewerUserId,
          approve,
          reviewNote: note,
        });

      case 'STATION_TRANSFER':
        return this.stationsService.reviewTransfer(
          requestId,
          reviewerUserId,
          approve,
          note,
        );

      case 'STATION_ZERO_BALANCE':
      case 'STATION_COUNTER_RESET':
      case 'STATION_INVENTORY_ADJUSTMENT':
        return this.stationsService.reviewActionRequest(requestId, {
          reviewerUserId,
          approve,
          reviewNote: note,
        });

      case 'EMPLOYEE_TRANSFER':
        return this.employeeTransfersService.reviewTransfer(
          requestId,
          reviewerUserId,
          approve,
          note,
        );

      case 'EMPLOYEE_PROJECT_REMOVAL':
        return this.employeeTransfersService.reviewProjectRemovalRequest(
          requestId,
          reviewerUserId,
          approve,
          note,
        );

      default:
        throw new BadRequestException(
          `Unsupported mobile approval type: ${rawType}`,
        );
    }
  }

  async getInbox(jwtUser?: JwtUser) {
    const jwtUserId = String(jwtUser?.userId || '').trim();
    const jwtCompanyId = String(jwtUser?.companyId || '').trim();

    if (!jwtUserId || !jwtCompanyId) {
      throw new UnauthorizedException('Authenticated user is required.');
    }

    // Do not trust role/company information from the client payload alone.
    // The JWT identifies the user, while the current database row remains
    // authoritative for active status, company and role.
    const currentUser = await (this.prisma as any).user.findFirst({
      where: {
        id: jwtUserId,
        companyId: jwtCompanyId,
        deletedAt: null,
        isActive: true,
      },
      include: {
        role: true,
      },
    });

    if (!currentUser) {
      throw new UnauthorizedException(
        'Authenticated user is invalid or inactive.',
      );
    }

    const userId = currentUser.id;
    const companyId = currentUser.companyId;
    const roleName = currentUser.role?.name || '';
    const isManager = this.isManagerRole(roleName);
    const isAdmin = this.isAdminRole(roleName);
    const canReviewOperationCorrections =
      isManager || this.isOperationCorrectionAdminRole(roleName);

    const managedProjects = isManager
      ? await (this.prisma as any).project.findMany({
          where: {
            companyId,
            projectManagerId: userId,
            deletedAt: null,
          },
          select: {
            id: true,
          },
        })
      : [];

    const managedProjectIds = managedProjects.map((project: any) => project.id);

    // Keep approval inbox reads sequential. This endpoint can touch several
    // approval domains, and firing all queries at once can exhaust/interrupt
    // a pooled PostgreSQL connection (Prisma P1017) against Supabase.
    const operationApprovals = await (this.prisma as any).operationApproval.findMany({
      where: {
        approverUserId: userId,
        status: 'PENDING',
        operation: {
          companyId,
          // Defensive filter for legacy/stale approval rows. A terminal operation
          // must never remain visible in the mobile approval inbox.
          status: {
            in: ['PENDING', 'PARTIALLY_APPROVED'],
          },
        },
      },
      include: {
        project: true,
        operation: {
          include: {
            requestedBy: true,
            asset: true,
            sourceStation: true,
            destinationStation: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 100,
    });

    const assetTransferApprovals = await (this.prisma as any).assetTransferApproval.findMany({
      where: {
        approverUserId: userId,
        status: 'PENDING',
        transferRequest: {
          companyId,
          status: {
            in: ['PENDING', 'PARTIALLY_APPROVED'],
          },
        },
      },
      include: {
        project: true,
        transferRequest: {
          include: {
            asset: true,
            fromProject: true,
            toProject: true,
            requestedBy: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 100,
    });

    const stationTransferApprovals = await (this.prisma as any).stationTransferApproval.findMany({
      where: {
        approverUserId: userId,
        status: 'PENDING',
        transferRequest: {
          companyId,
          status: {
            in: ['PENDING', 'PARTIALLY_APPROVED'],
          },
        },
      },
      include: {
        project: true,
        transferRequest: {
          include: {
            station: true,
            fromProject: true,
            toProject: true,
            requestedBy: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 100,
    });

    const employeeTransferApprovals = await (this.prisma as any).employeeTransferApproval.findMany({
      where: {
        approverUserId: userId,
        status: 'PENDING',
        transferRequest: {
          companyId,
          status: {
            in: ['PENDING', 'PARTIALLY_APPROVED'],
          },
        },
      },
      include: {
        project: true,
        transferRequest: {
          include: {
            employee: true,
            fromProject: true,
            toProject: true,
            requestedBy: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 100,
    });

    const employeeProjectRemovalRequests = await (this.prisma as any).employeeProjectRemovalRequest.findMany({
      where: {
        companyId,
        approverUserId: userId,
        status: 'PENDING',
      },
      include: {
        employee: true,
        project: true,
        requestedBy: true,
        transferRequest: {
          include: {
            fromProject: true,
            toProject: true,
          },
        },
      },
      orderBy: {
        requestedAt: 'desc',
      },
      take: 100,
    });

    const assetActionRequests =
      isManager && managedProjectIds.length > 0
        ? await (this.prisma as any).assetActionRequest.findMany({
            where: {
              companyId,
              status: 'PENDING',
              actionType: 'ODOMETER_RESET',
              OR: [
                {
                  projectId: {
                    in: managedProjectIds,
                  },
                },
                {
                  asset: {
                    projectId: {
                      in: managedProjectIds,
                    },
                  },
                },
              ],
            },
            include: {
              asset: true,
              project: true,
              requestedBy: true,
            },
            orderBy: {
              createdAt: 'desc',
            },
            take: 100,
          })
        : [];

    const stationActionRequests =
      isAdmin || (isManager && managedProjectIds.length > 0)
        ? await (this.prisma as any).stationActionRequest.findMany({
            where: {
              companyId,
              status: 'PENDING',
              OR: [
                ...(isAdmin
                  ? [
                      {
                        actionType: 'INVENTORY_ADJUSTMENT',
                      },
                    ]
                  : []),
                ...(isManager && managedProjectIds.length > 0
                  ? [
                      {
                        actionType: {
                          in: ['ZERO_BALANCE', 'COUNTER_RESET'],
                        },
                        OR: [
                          {
                            projectId: {
                              in: managedProjectIds,
                            },
                          },
                          {
                            station: {
                              projectId: {
                                in: managedProjectIds,
                              },
                            },
                          },
                        ],
                      },
                    ]
                  : []),
              ],
            },
            include: {
              station: true,
              project: true,
              requestedBy: true,
            },
            orderBy: {
              createdAt: 'desc',
            },
            take: 100,
          })
        : [];

    const operationCorrections = canReviewOperationCorrections
      ? await (this.prisma as any).operationCorrection.findMany({
          where: {
            companyId,
            status: 'PENDING',
            ...(isManager
              ? {
                  operation: {
                    OR: [
                      {
                        projectIdAtOperation: {
                          in: managedProjectIds,
                        },
                      },
                      {
                        sourceProjectIdAtOperation: {
                          in: managedProjectIds,
                        },
                      },
                      {
                        destinationProjectIdAtOperation: {
                          in: managedProjectIds,
                        },
                      },
                    ],
                  },
                }
              : {}),
          },
          include: {
            requestedBy: true,
            operation: {
              include: {
                asset: true,
                sourceStation: true,
                destinationStation: true,
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 100,
        })
      : [];

    const items: ApprovalInboxItem[] = [];

    for (const approval of operationApprovals) {
      const operation = approval.operation;

      const entity =
        operation.asset
          ? {
              id: operation.asset.id,
              code: operation.asset.assetId,
              name: operation.asset.type || null,
              kind: 'ASSET',
            }
          : operation.sourceStation
            ? {
                id: operation.sourceStation.id,
                code: operation.sourceStation.stationId,
                name: operation.sourceStation.name || null,
                kind: 'STATION',
              }
            : operation.destinationStation
              ? {
                  id: operation.destinationStation.id,
                  code: operation.destinationStation.stationId,
                  name: operation.destinationStation.name || null,
                  kind: 'STATION',
                }
              : null;

      items.push({
        id: operation.id,
        approvalId: approval.id,
        type: String(operation.type || 'OPERATION'),
        module: 'OPERATIONS',
        status: String(operation.status || 'PENDING'),
        approvalStage: approval.approvalStage || null,
        reference: operation.operationNo || operation.id,
        requestedAt: operation.createdAt,
        requestedBy: this.requestedByInfo(operation.requestedBy),
        fromProject: operation.sourceProjectIdAtOperation
          ? {
              id: operation.sourceProjectIdAtOperation,
              code: null,
              name: operation.sourceProjectNameAtOperation || null,
            }
          : null,
        toProject: operation.destinationProjectIdAtOperation
          ? {
              id: operation.destinationProjectIdAtOperation,
              code: null,
              name: operation.destinationProjectNameAtOperation || null,
            }
          : operation.projectIdAtOperation
            ? {
                id: operation.projectIdAtOperation,
                code: null,
                name: operation.projectNameAtOperation || null,
              }
            : null,
        project: this.projectInfo(approval.project),
        entity,
        summary: {
          operationType: operation.type,
          quantity: operation.quantity,
          occurredAt: operation.occurredAt,
          assetCode: operation.asset?.assetId || null,
          sourceStationCode: operation.sourceStation?.stationId || null,
          destinationStationCode:
            operation.destinationStation?.stationId || null,
          externalStationName: operation.externalStationName || null,
          invoiceNumber: operation.invoiceNumber || null,
          notes: operation.notes || null,
        },
        availableActions: ['APPROVE', 'REJECT'],
      });
    }

    for (const approval of assetTransferApprovals) {
      const request = approval.transferRequest;

      items.push({
        id: request.id,
        approvalId: approval.id,
        type: 'ASSET_TRANSFER',
        module: 'ASSETS',
        status: String(request.status || 'PENDING'),
        approvalStage: approval.approvalStage || null,
        reference: request.transferBatchId || request.id,
        requestedAt: request.createdAt,
        requestedBy: this.requestedByInfo(request.requestedBy),
        fromProject: this.projectInfo(request.fromProject),
        toProject: this.projectInfo(request.toProject),
        project: this.projectInfo(approval.project),
        entity: {
          id: request.asset?.id || request.assetId || null,
          code: request.asset?.assetId || null,
          name: request.asset?.type || null,
          kind: 'ASSET',
        },
        summary: {
          reason: request.reason || null,
          transferBatchId: request.transferBatchId || null,
        },
        availableActions: ['APPROVE', 'REJECT'],
      });
    }

    for (const approval of stationTransferApprovals) {
      const request = approval.transferRequest;

      items.push({
        id: request.id,
        approvalId: approval.id,
        type: 'STATION_TRANSFER',
        module: 'STATIONS',
        status: String(request.status || 'PENDING'),
        approvalStage: approval.approvalStage || null,
        reference: request.id,
        requestedAt: request.createdAt,
        requestedBy: this.requestedByInfo(request.requestedBy),
        fromProject: this.projectInfo(request.fromProject),
        toProject: this.projectInfo(request.toProject),
        project: this.projectInfo(approval.project),
        entity: {
          id: request.station?.id || request.stationId || null,
          code: request.station?.stationId || null,
          name: request.station?.name || null,
          kind: 'STATION',
        },
        summary: {
          reason: request.reason || null,
          stockAtTransfer: request.stockAtTransfer ?? null,
        },
        availableActions: ['APPROVE', 'REJECT'],
      });
    }

    for (const approval of employeeTransferApprovals) {
      const request = approval.transferRequest;

      items.push({
        id: request.id,
        approvalId: approval.id,
        type: 'EMPLOYEE_TRANSFER',
        module: 'EMPLOYEES',
        status: String(request.status || 'PENDING'),
        approvalStage: approval.approvalStage || null,
        reference: request.transferBatchId || request.id,
        requestedAt: request.createdAt,
        requestedBy: this.requestedByInfo(request.requestedBy),
        fromProject: this.projectInfo(request.fromProject),
        toProject: this.projectInfo(request.toProject),
        project: this.projectInfo(approval.project),
        entity: {
          id: request.employee?.id || request.employeeId || null,
          code:
            request.employeeCodeAtTransfer ||
            request.employee?.employeeId ||
            null,
          name:
            request.employeeNameAtTransfer ||
            request.employee?.name ||
            null,
          kind: 'EMPLOYEE',
        },
        summary: {
          reason: request.reason || null,
          keepLinkedProjects: request.keepLinkedProjects ?? null,
          transferBatchId: request.transferBatchId || null,
        },
        availableActions: ['APPROVE', 'REJECT'],
      });
    }

    for (const request of employeeProjectRemovalRequests) {
      items.push({
        id: request.id,
        approvalId: null,
        type: 'EMPLOYEE_PROJECT_REMOVAL',
        module: 'EMPLOYEES',
        status: String(request.status || 'PENDING'),
        approvalStage: 'PROJECT_MANAGER',
        reference: request.id,
        requestedAt: request.requestedAt,
        requestedBy: this.requestedByInfo(request.requestedBy),
        fromProject: this.projectInfo(request.project),
        toProject: this.projectInfo(request.transferRequest?.toProject),
        project: this.projectInfo(request.project),
        entity: {
          id: request.employee?.id || request.employeeId || null,
          code: request.employee?.employeeId || null,
          name: request.employee?.name || null,
          kind: 'EMPLOYEE',
        },
        summary: {
          reason: request.reason || null,
          transferRequestId: request.transferRequestId,
          primaryFromProject:
            this.projectInfo(request.transferRequest?.fromProject),
          primaryToProject:
            this.projectInfo(request.transferRequest?.toProject),
        },
        availableActions: ['APPROVE', 'REJECT'],
      });
    }

    for (const request of assetActionRequests) {
      items.push({
        id: request.id,
        approvalId: null,
        type: 'ASSET_ODOMETER_RESET',
        module: 'ASSETS',
        status: String(request.status || 'PENDING'),
        approvalStage: 'PROJECT_MANAGER',
        reference: request.id,
        requestedAt: request.createdAt,
        requestedBy: this.requestedByInfo(request.requestedBy),
        fromProject: null,
        toProject: null,
        project: this.projectInfo(request.project),
        entity: {
          id: request.asset?.id || request.assetId || null,
          code: request.asset?.assetId || null,
          name: request.asset?.type || null,
          kind: 'ASSET',
        },
        summary: {
          actionType: request.actionType,
          reason: request.reason,
          requestedOdometer: request.requestedOdometer ?? null,
          requestedOldOdometer: request.requestedOldOdometer ?? null,
          effectiveAt: request.effectiveAt || null,
        },
        availableActions: ['APPROVE', 'REJECT'],
      });
    }

    for (const request of stationActionRequests) {
      const actionType = String(request.actionType || '');

      items.push({
        id: request.id,
        approvalId: null,
        type:
          actionType === 'ZERO_BALANCE'
            ? 'STATION_ZERO_BALANCE'
            : actionType === 'COUNTER_RESET'
              ? 'STATION_COUNTER_RESET'
              : 'STATION_INVENTORY_ADJUSTMENT',
        module: 'STATIONS',
        status: String(request.status || 'PENDING'),
        approvalStage:
          actionType === 'INVENTORY_ADJUSTMENT'
            ? 'ADMIN'
            : 'PROJECT_MANAGER',
        reference: request.id,
        requestedAt: request.createdAt,
        requestedBy: this.requestedByInfo(request.requestedBy),
        fromProject: null,
        toProject: null,
        project: this.projectInfo(request.project),
        entity: {
          id: request.station?.id || request.stationId || null,
          code: request.station?.stationId || null,
          name: request.station?.name || null,
          kind: 'STATION',
        },
        summary: {
          actionType: request.actionType,
          reason: request.reason,
          requestedActualStock: request.requestedActualStock ?? null,
          requestedCounter: request.requestedCounter ?? null,
          effectiveAt: request.effectiveAt || null,
          movementAt: request.movementAt || null,
        },
        availableActions: ['APPROVE', 'REJECT'],
      });
    }

    for (const correction of operationCorrections) {
      const operation = correction.operation;
      const entity =
        operation?.asset
          ? {
              id: operation.asset.id,
              code: operation.asset.assetId,
              name: operation.asset.type || null,
              kind: 'ASSET',
            }
          : operation?.sourceStation
            ? {
                id: operation.sourceStation.id,
                code: operation.sourceStation.stationId,
                name: operation.sourceStation.name || null,
                kind: 'STATION',
              }
            : null;

      items.push({
        id: correction.id,
        approvalId: null,
        type: 'OPERATION_CORRECTION',
        module: 'OPERATIONS',
        status: String(correction.status || 'PENDING'),
        approvalStage: isManager ? 'PROJECT_MANAGER' : 'ADMIN',
        reference: operation?.operationNo || correction.id,
        requestedAt: correction.createdAt,
        requestedBy: this.requestedByInfo(correction.requestedBy),
        fromProject: operation?.sourceProjectIdAtOperation
          ? {
              id: operation.sourceProjectIdAtOperation,
              code: null,
              name: operation.sourceProjectNameAtOperation || null,
            }
          : null,
        toProject: operation?.destinationProjectIdAtOperation
          ? {
              id: operation.destinationProjectIdAtOperation,
              code: null,
              name: operation.destinationProjectNameAtOperation || null,
            }
          : operation?.projectIdAtOperation
            ? {
                id: operation.projectIdAtOperation,
                code: null,
                name: operation.projectNameAtOperation || null,
              }
            : null,
        project: null,
        entity,
        summary: {
          operationId: correction.operationId,
          fieldName: correction.fieldName,
          oldValue: correction.oldValue,
          newValue: correction.newValue,
          reason: correction.reason,
        },
        availableActions: ['APPROVE', 'REJECT'],
      });
    }

    const sortedItems = this.sortItems(items);

    return {
      ok: true,
      count: sortedItems.length,
      items: sortedItems,
    };
  }
}
