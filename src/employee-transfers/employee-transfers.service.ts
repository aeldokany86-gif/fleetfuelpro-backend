import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { randomUUID } from 'crypto';

@Injectable()
export class EmployeeTransfersService {
  constructor(
    private prisma: PrismaService,
  ) {}

  private normalizeRoleName(roleName: string) {
    return String(roleName || '')
      .trim()
      .toUpperCase()
      .replace(/[\s_-]+/g, '');
  }

  private parseEffectiveDate(value?: string | Date | null) {
    if (!value) return null;

    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(
        'Effective date is invalid',
      );
    }

    return date;
  }

  private isAdminRole(roleName: string) {
    const normalized = this.normalizeRoleName(roleName);
    return (
      normalized === 'ADMIN' ||
      normalized === 'PLATFORMADMIN' ||
      normalized === 'PLATFORMUSER'
    );
  }

  private isOfficerRole(roleName: string) {
    return this.normalizeRoleName(roleName) === 'OFFICER';
  }

  private isManagerRole(roleName: string) {
    return this.normalizeRoleName(roleName) === 'MANAGER';
  }

  private isTopManagementRole(roleName: string) {
    return this.normalizeRoleName(roleName) === 'TOPMANAGEMENT';
  }

  private isAdminApprovalEmployeeRole(roleName: string) {
    return (
      this.isManagerRole(roleName) ||
      this.isTopManagementRole(roleName)
    );
  }

  private getEmployeeRoleName(employee: any) {
    // Manager Transfer must be based on the linked system user role only.
    // Job title is not a security/approval role and must not trigger Admin approval.
    return employee?.linkedUser?.role?.name || '';
  }

  private isAdminApprovalEmployee(employee: any) {
    return this.isAdminApprovalEmployeeRole(
      this.getEmployeeRoleName(employee),
    );
  }

  private isManagerTransferRequest(request: any) {
    return (
      String(request?.reason || '')
        .toUpperCase()
        .includes('MANAGER_TRANSFER_ADMIN_APPROVAL') ||
      String(request?.reason || '')
        .toUpperCase()
        .includes('ADMIN_APPROVAL_EMPLOYEE_TRANSFER') ||
      this.isAdminApprovalEmployee(request?.employee)
    );
  }

  private async getRequester(
    requestedByUserId: string,
    companyId: string,
  ) {
    const requester =
      await this.prisma.user.findFirst({
        where: {
          id: requestedByUserId,
          companyId,
          deletedAt: null,
          isActive: true,
        },
        include: {
          role: true,
        },
      });

    if (!requester) {
      throw new BadRequestException(
        'Requester user is invalid or inactive',
      );
    }

    return requester;
  }

  private async getActiveAdmins(companyId: string) {
    const admins =
      await this.prisma.user.findMany({
        where: {
          companyId,
          deletedAt: null,
          isActive: true,
          role: {
            is: {
              name: {
                in: [
                  'Admin',
                  'ADMIN',
                  'PlatformAdmin',
                  'Platform Admin',
                  'Platform User',
                ],
              },
            },
          },
        },
        include: {
          role: true,
        },
      });

    const normalizedAdmins = admins.filter((admin) =>
      this.isAdminRole(admin.role?.name || ''),
    );

    if (!normalizedAdmins.length) {
      throw new BadRequestException(
        'Manager or Top Management transfer requires an active Admin approver',
      );
    }

    return normalizedAdmins;
  }

  private async assertAdminReviewer(
    reviewerUserId: string,
    companyId: string,
  ) {
    const reviewer =
      await this.prisma.user.findFirst({
        where: {
          id: reviewerUserId,
          companyId,
          deletedAt: null,
          isActive: true,
        },
        include: {
          role: true,
        },
      });

    if (!reviewer || !this.isAdminRole(reviewer.role?.name || '')) {
      throw new BadRequestException(
        'Only Admin can approve Manager or Top Management transfer',
      );
    }

    return reviewer;
  }

  private buildUniqueApprovers(
    approvers: Array<{
      approverUserId: string;
      projectId: string;
      approvalStage: string;
    }>,
  ) {
    return approvers.filter(
      (item, index, list) =>
        list.findIndex(
          (candidate) =>
            candidate.approverUserId ===
            item.approverUserId,
        ) === index,
    );
  }

  private buildInclude() {
    return {
      employee: {
        include: {
          linkedUser: {
            include: {
              role: true,
            },
          },
        },
      },
      fromProject: true,
      toProject: true,
      approvals: true,
      projectRemovalRequests: true,
    };
  }


  private async applyMultiProjectTransferState(
    tx: any,
    request: any,
  ) {
    // Keep the common "keep linked projects" path intentionally lightweight.
    // The transfer transaction only needs the company feature flag before
    // applying the Primary/Additional swap; full assignment loading is needed
    // only for the optional cleanup workflow.
    const company = await tx.company.findUnique({
      where: { id: request.companyId },
      select: { multiProjectEnabled: true },
    });

    if (!company) {
      throw new NotFoundException('Company not found while applying transfer');
    }

    await tx.employee.update({
      where: { id: request.employeeId },
      data: { projectId: request.toProjectId },
    });

    // The destination becomes Primary, therefore it must never remain duplicated
    // in the Additional Projects table.
    await tx.employeeProjectAssignment.deleteMany({
      where: {
        employeeId: request.employeeId,
        projectId: request.toProjectId,
      },
    });

    if (!company.multiProjectEnabled) {
      return;
    }

    if (request.keepLinkedProjects !== false) {
      // Transfer changes only the Primary Project. The old Primary becomes
      // Additional and all other Additional links are preserved.
      if (request.fromProjectId && request.fromProjectId !== request.toProjectId) {
        await tx.employeeProjectAssignment.upsert({
          where: {
            employeeId_projectId: {
              employeeId: request.employeeId,
              projectId: request.fromProjectId,
            },
          },
          update: {},
          create: {
            companyId: request.companyId,
            employeeId: request.employeeId,
            projectId: request.fromProjectId,
            assignedByUserId: request.requestedByUserId,
          },
        });
      }
      return;
    }

    // Cleanup mode needs the remaining Additional links. This query is deferred
    // until here so normal transfers do not carry unnecessary relation loading
    // inside the interactive Prisma transaction.
    const additionalAssignments = await tx.employeeProjectAssignment.findMany({
      where: {
        employeeId: request.employeeId,
      },
      select: { projectId: true },
    });

    const previousLinkedProjectIds = Array.from(
      new Set([
        request.fromProjectId,
        ...additionalAssignments.map((assignment: any) => assignment.projectId),
      ]),
    ).filter((projectId) => projectId && projectId !== request.toProjectId);

    if (!previousLinkedProjectIds.length) {
      return;
    }

    const linkedProjects = await tx.project.findMany({
      where: {
        id: { in: previousLinkedProjectIds },
        companyId: request.companyId,
        deletedAt: null,
      },
      select: {
        id: true,
        projectManagerId: true,
      },
    });

    const projectById = new Map(
      linkedProjects.map((project: any) => [project.id, project]),
    );

    const requester = await tx.user.findUnique({
      where: { id: request.requestedByUserId },
      include: { role: true },
    });
    const requesterIsManager = this.isManagerRole(requester?.role?.name || '');

    for (const projectId of previousLinkedProjectIds) {
      const project = projectById.get(projectId) as any;
      if (!project) continue;

      // Primary Project is always protected; this is a second guard in case
      // project state changes between request creation and application.
      if (projectId === request.toProjectId) continue;

      const requesterManagesProject =
        requesterIsManager && project.projectManagerId === request.requestedByUserId;

      if (requesterManagesProject) {
        await tx.employeeProjectAssignment.deleteMany({
          where: {
            employeeId: request.employeeId,
            projectId,
          },
        });
        continue;
      }

      // Keep the access active until that project's manager approves removal.
      await tx.employeeProjectAssignment.upsert({
        where: {
          employeeId_projectId: {
            employeeId: request.employeeId,
            projectId,
          },
        },
        update: {},
        create: {
          companyId: request.companyId,
          employeeId: request.employeeId,
          projectId,
          assignedByUserId: request.requestedByUserId,
        },
      });

      if (!project.projectManagerId) {
        // No silent deletion when a project has no manager. Access stays in place.
        // An Admin can resolve the project manager first, then the removal can be
        // requested explicitly from Team management.
        continue;
      }

      await tx.employeeProjectRemovalRequest.upsert({
        where: {
          transferRequestId_employeeId_projectId: {
            transferRequestId: request.id,
            employeeId: request.employeeId,
            projectId,
          },
        },
        update: {},
        create: {
          companyId: request.companyId,
          employeeId: request.employeeId,
          projectId,
          transferRequestId: request.id,
          requestedByUserId: request.requestedByUserId,
          approverUserId: project.projectManagerId,
          status: 'PENDING',
          reason: 'REMOVE_LINKED_PROJECT_AFTER_EMPLOYEE_TRANSFER',
        },
      });
    }
  }

  async getPendingProjectRemovalRequests(approverUserId: string) {
    if (!approverUserId) {
      throw new BadRequestException('Approver user ID is required');
    }

    return this.prisma.employeeProjectRemovalRequest.findMany({
      where: {
        approverUserId,
        status: 'PENDING',
      },
      include: {
        employee: true,
        project: true,
        transferRequest: {
          include: {
            fromProject: true,
            toProject: true,
          },
        },
        requestedBy: {
          select: { id: true, fullName: true, email: true },
        },
      },
      orderBy: { requestedAt: 'desc' },
    });
  }

  async reviewProjectRemovalRequest(
    requestId: string,
    reviewerUserId: string,
    approve: boolean,
    rejectionReason?: string,
  ) {
    const request = await this.prisma.employeeProjectRemovalRequest.findUnique({
      where: { id: requestId },
      include: { employee: true, project: true },
    });

    if (!request) {
      throw new NotFoundException('Project removal request not found');
    }

    if (request.status !== 'PENDING') {
      throw new BadRequestException('Project removal request already reviewed');
    }

    if (request.approverUserId !== reviewerUserId) {
      throw new BadRequestException('User cannot review this project removal request');
    }

    const reviewer = await this.getRequester(reviewerUserId, request.companyId);
    if (!this.isManagerRole(reviewer.role?.name || '')) {
      throw new BadRequestException('Only the assigned Project Manager can review this removal request');
    }

    const now = new Date();

    if (!approve) {
      return this.prisma.employeeProjectRemovalRequest.update({
        where: { id: requestId },
        data: {
          status: 'REJECTED',
          reviewedByUserId: reviewerUserId,
          reviewedAt: now,
          rejectionReason: rejectionReason || 'Rejected',
        },
        include: { employee: true, project: true },
      });
    }

    // Never remove the employee from the current Primary Project, even if an
    // older pending request exists for that project.
    if (request.employee.projectId === request.projectId) {
      throw new BadRequestException('Current primary project cannot be removed');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.employeeProjectAssignment.deleteMany({
        where: {
          employeeId: request.employeeId,
          projectId: request.projectId,
        },
      });

      return tx.employeeProjectRemovalRequest.update({
        where: { id: requestId },
        data: {
          status: 'APPROVED',
          reviewedByUserId: reviewerUserId,
          reviewedAt: now,
        },
        include: { employee: true, project: true },
      });
    }, { timeout: 60000 });
  }

  async createTransferRequest(
    employeeId: string,
    toProjectId: string,
    requestedByUserId: string,
    effectiveDate?: string | Date | null,
    transferBatchId?: string | null,
    keepLinkedProjects: boolean = true,
  ) {
    const employee =
      await this.prisma.employee.findFirst({
        where: {
          id: employeeId,
          deletedAt: null,
        },

        include: {
          project: true,
          linkedUser: {
            include: {
              role: true,
            },
          },
        },
      });

    if (!employee) {
      throw new NotFoundException(
        'Employee not found',
      );
    }

    if (!employee.projectId) {
      throw new BadRequestException(
        'Employee has no current project',
      );
    }

    if (employee.projectId === toProjectId) {
      throw new BadRequestException(
        'Employee already belongs to this project',
      );
    }

    const targetProject =
      await this.prisma.project.findFirst({
        where: {
          id: toProjectId,
          deletedAt: null,
          isActive: true,
          companyId: employee.companyId,
        },
      });

    if (!targetProject) {
      throw new BadRequestException(
        'Target project is invalid',
      );
    }

    const requester = await this.getRequester(
      requestedByUserId,
      employee.companyId,
    );

    const requesterRoleName =
      requester.role?.name || '';

    if (this.isAdminRole(requesterRoleName)) {
      throw new BadRequestException(
        'Admin cannot create employee transfer requests',
      );
    }

    const isManagerTransfer =
      this.isAdminApprovalEmployee(employee);

    if (
      isManagerTransfer &&
      !this.isOfficerRole(requesterRoleName)
    ) {
      throw new BadRequestException(
        'Only Officer can create Manager or Top Management transfer requests',
      );
    }

    if (
      !isManagerTransfer &&
      !this.isOfficerRole(requesterRoleName) &&
      !this.isManagerRole(requesterRoleName)
    ) {
      throw new BadRequestException(
        'Only Officer or Manager can create employee transfer requests',
      );
    }

    const pending =
      await this.prisma.employeeTransferRequest.findFirst({
        where: {
          employeeId,
          status: {
            in: [
              'PENDING',
              'PARTIALLY_APPROVED',
            ],
          },
        },
      });

    if (pending) {
      throw new BadRequestException(
        'Pending transfer already exists',
      );
    }

    const now = new Date();
    const requestedEffectiveDate = this.parseEffectiveDate(effectiveDate);

    if (isManagerTransfer) {
      const admins =
        await this.getActiveAdmins(employee.companyId);

      return this.prisma.employeeTransferRequest.create({
        data: {
          companyId: employee.companyId,
          employeeId,
          fromProjectId: employee.projectId!,
          toProjectId,
          requestedByUserId,
          transferBatchId: transferBatchId || null,
          keepLinkedProjects,
          employeeCodeAtTransfer: employee.employeeId,
          employeeNameAtTransfer: employee.name,
          status: 'PENDING',
          effectiveDate: requestedEffectiveDate,
          reason: 'ADMIN_APPROVAL_EMPLOYEE_TRANSFER',
          approvals: {
            create: admins.map((admin) => ({
              approverUserId: admin.id,
              projectId: employee.projectId!,
              approvalStage: 'Admin Approval',
              status: 'PENDING' as any,
              reviewedAt: null,
              note: 'Manager or Top Management transfer requires Admin approval',
            })),
          },
        },
        include: this.buildInclude(),
      });
    }

    if (
      !employee.project?.projectManagerId ||
      !targetProject.projectManagerId
    ) {
      throw new BadRequestException(
        'Employee transfer requires source and destination project managers',
      );
    }

    const approvers =
      this.buildUniqueApprovers([
        {
          approverUserId:
            employee.project.projectManagerId,
          projectId: employee.projectId!,
          approvalStage: 'Source Project Manager',
        },
        {
          approverUserId:
            targetProject.projectManagerId,
          projectId: targetProject.id,
          approvalStage:
            'Destination Project Manager',
        },
      ]);

    const approvalsToCreate = approvers.map(
      (approver) => {
        const requesterIsThisProjectManager =
          approver.approverUserId ===
          requestedByUserId;

        return {
          approverUserId: approver.approverUserId,
          projectId: approver.projectId,
          approvalStage: approver.approvalStage,
          status: requesterIsThisProjectManager
            ? 'APPROVED'
            : 'PENDING',
          reviewedAt: requesterIsThisProjectManager
            ? now
            : null,
          note: requesterIsThisProjectManager
            ? 'Auto-approved because the requester is this project manager'
            : null,
        };
      },
    );

    const fullyApproved =
      approvalsToCreate.every(
        (approval) =>
          approval.status === 'APPROVED',
      );

    const partiallyApproved =
      approvalsToCreate.some(
        (approval) =>
          approval.status === 'APPROVED',
      );

    return this.prisma.$transaction(async (tx) => {
      const transferRequest =
        await tx.employeeTransferRequest.create({
          data: {
            companyId: employee.companyId,
            employeeId,
            fromProjectId: employee.projectId!,
            toProjectId,
            requestedByUserId,
            transferBatchId: transferBatchId || null,
            keepLinkedProjects,
            employeeCodeAtTransfer: employee.employeeId,
            employeeNameAtTransfer: employee.name,
            status: fullyApproved
              ? 'APPROVED'
              : partiallyApproved
                ? 'PARTIALLY_APPROVED'
                : 'PENDING',
            effectiveDate: fullyApproved
              ? (requestedEffectiveDate || now)
              : requestedEffectiveDate,
            ...(fullyApproved
              ? {
                  approvedAt: now,
                  appliedAt: now,
                  reason:
                    'Auto-applied because the requester manages all required approval stages',
                }
              : partiallyApproved
                ? {
                    reason:
                      'Partially auto-approved because the requester manages one required approval stage',
                  }
                : {}),
            approvals: {
              create: approvalsToCreate.map(
                (approval) => ({
                  approverUserId:
                    approval.approverUserId,
                  projectId: approval.projectId,
                  approvalStage:
                    approval.approvalStage,
                  status: approval.status as any,
                  reviewedAt: approval.reviewedAt,
                  note: approval.note,
                }),
              ),
            },
          },
          include: this.buildInclude(),
        });

      if (!fullyApproved) {
        return transferRequest;
      }

      await this.applyMultiProjectTransferState(tx, transferRequest);

      return tx.employeeTransferRequest.findFirst({
        where: {
          id: transferRequest.id,
        },
        include: this.buildInclude(),
      });
    }, { timeout: 60000 });
  }

  async createBulkTransferRequests(
    employeeIds: string[],
    toProjectId: string,
    requestedByUserId: string,
    keepLinkedProjects: boolean = true,
  ) {
    const uniqueEmployeeIds = Array.from(
      new Set(
        (Array.isArray(employeeIds) ? employeeIds : [])
          .map((id) => String(id || '').trim())
          .filter(Boolean),
      ),
    );

    if (!uniqueEmployeeIds.length) {
      throw new BadRequestException('At least one employee is required');
    }

    if (!toProjectId) {
      throw new BadRequestException('Target project is required');
    }

    if (!requestedByUserId) {
      throw new BadRequestException('Requester user ID is required');
    }

    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const transferBatchId = `ETB-${datePart}-${randomUUID()
      .slice(0, 8)
      .toUpperCase()}`;
    const transfers: Array<
  Awaited<
    ReturnType<EmployeeTransfersService["createTransferRequest"]>
  >
> = [];

    // Sequential creation keeps the same validation and snapshot-safe transfer
    // behavior as the existing single-request path for every employee.
    for (const employeeId of uniqueEmployeeIds) {
      transfers.push(
        await this.createTransferRequest(
          employeeId,
          toProjectId,
          requestedByUserId,
          null,
          transferBatchId,
          keepLinkedProjects,
        ),
      );
    }

    return {
      transferBatchId,
      requestedCount: uniqueEmployeeIds.length,
      createdCount: transfers.length,
      transfers,
    };
  }

  async getPendingRequests() {
    return this.prisma.employeeTransferRequest.findMany({
      where: {
        status: {
          in: [
            'PENDING',
            'PARTIALLY_APPROVED',
          ],
        },
      },

      include: this.buildInclude(),

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async getTransferReport(filters: {
    companyId: string;
    employeeId?: string;
    fromProjectId?: string;
    toProjectId?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    if (!filters.companyId) {
      throw new BadRequestException('Company ID is required');
    }

    const createdAt: Record<string, Date> = {};
    if (filters.dateFrom) {
      const from = new Date(filters.dateFrom);
      if (Number.isNaN(from.getTime())) {
        throw new BadRequestException('dateFrom is invalid');
      }
      createdAt.gte = from;
    }
    if (filters.dateTo) {
      const to = new Date(filters.dateTo);
      if (Number.isNaN(to.getTime())) {
        throw new BadRequestException('dateTo is invalid');
      }
      to.setHours(23, 59, 59, 999);
      createdAt.lte = to;
    }

    const requests = await this.prisma.employeeTransferRequest.findMany({
      where: {
        companyId: filters.companyId,
        ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
        ...(filters.fromProjectId ? { fromProjectId: filters.fromProjectId } : {}),
        ...(filters.toProjectId ? { toProjectId: filters.toProjectId } : {}),
        ...(filters.status ? { status: filters.status as any } : {}),
        ...(Object.keys(createdAt).length ? { createdAt } : {}),
      },
      include: {
        employee: true,
        fromProject: true,
        toProject: true,
        requestedBy: {
          select: { id: true, fullName: true, email: true },
        },
        approvals: {
          include: {
            approver: {
              select: { id: true, fullName: true, email: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const rows = requests.map((request) => ({
      id: request.id,
      transferBatchId: request.transferBatchId,
      employeeBackendId: request.employeeId,
      employeeCode:
        request.employeeCodeAtTransfer || request.employee.employeeId,
      employeeName:
        request.employeeNameAtTransfer || request.employee.name,
      fromProjectId: request.fromProjectId,
      fromProjectName: request.fromProject.name || request.fromProject.code,
      toProjectId: request.toProjectId,
      toProjectName: request.toProject.name || request.toProject.code,
      requestedByUserId: request.requestedByUserId,
      requestedByName:
        request.requestedBy.fullName || request.requestedBy.email,
      status: request.status,
      keepLinkedProjects: request.keepLinkedProjects,
      reason: request.reason,
      rejectionReason: request.rejectionReason,
      requestedAt: request.createdAt,
      approvedAt: request.approvedAt,
      rejectedAt: request.rejectedAt,
      appliedAt: request.appliedAt,
      approvals: request.approvals.map((approval) => ({
        id: approval.id,
        approvalStage: approval.approvalStage,
        projectId: approval.projectId,
        approverUserId: approval.approverUserId,
        approverName:
          approval.approver.fullName || approval.approver.email,
        status: approval.status,
        note: approval.note,
        reviewedAt: approval.reviewedAt,
      })),
    }));

    return {
      summary: {
        total: rows.length,
        pending: rows.filter((row) => row.status === 'PENDING').length,
        partiallyApproved: rows.filter(
          (row) => row.status === 'PARTIALLY_APPROVED',
        ).length,
        approved: rows.filter((row) => row.status === 'APPROVED').length,
        rejected: rows.filter((row) => row.status === 'REJECTED').length,
      },
      rows,
    };
  }

  async reviewTransfer(
    transferId: string,
    managerUserId: string,
    approve: boolean,
    rejectionReason?: string,
  ) {
    const request =
      await this.prisma.employeeTransferRequest.findFirst({
        where: {
          id: transferId,
        },

        include: this.buildInclude(),
      });

    if (!request) {
      throw new NotFoundException(
        'Transfer request not found',
      );
    }

    if (
      ![
        'PENDING',
        'PARTIALLY_APPROVED',
      ].includes(request.status)
    ) {
      throw new BadRequestException(
        'Transfer already reviewed',
      );
    }

    const now = new Date();
    const isManagerTransfer =
      this.isManagerTransferRequest(request);

    if (isManagerTransfer) {
      await this.assertAdminReviewer(
        managerUserId,
        request.companyId,
      );

      const adminPendingApproval =
        request.approvals.find(
          (approval) =>
            approval.approverUserId ===
              managerUserId &&
            approval.status === 'PENDING',
        ) ||
        request.approvals.find(
          (approval) =>
            approval.approvalStage ===
              'Admin Approval' &&
            approval.status === 'PENDING',
        );

      if (!adminPendingApproval) {
        throw new BadRequestException(
          'No pending Admin approval found for this Manager or Top Management transfer',
        );
      }

      if (!approve) {
        return this.prisma.$transaction(async (tx) => {
          await tx.employeeTransferApproval.update({
            where: {
              id: adminPendingApproval.id,
            },
            data: {
              status: 'REJECTED',
              note: rejectionReason || 'Rejected',
              reviewedAt: now,
            },
          });

          return tx.employeeTransferRequest.update({
            where: {
              id: transferId,
            },
            data: {
              status: 'REJECTED',
              rejectedAt: now,
              rejectionReason:
                rejectionReason || 'Rejected',
            },
            include: this.buildInclude(),
          });
        }, { timeout: 60000 });
      }

      return this.prisma.$transaction(async (tx) => {
        await tx.employeeTransferApproval.update({
          where: {
            id: adminPendingApproval.id,
          },
          data: {
            approverUserId: managerUserId,
            status: 'APPROVED',
            reviewedAt: now,
            note: request.reason
              ? `${request.reason}; Approved by Admin ${managerUserId}`
              : `Approved by Admin ${managerUserId}`,
          },
        });

        await this.applyMultiProjectTransferState(tx, request);

        return tx.employeeTransferRequest.update({
          where: {
            id: transferId,
          },
          data: {
            status: 'APPROVED',
            approvedAt: now,
            appliedAt: now,
            effectiveDate: request.effectiveDate || now,
            reason: `Manager or Top Management transfer approved by Admin ${managerUserId}`,
          },
          include: this.buildInclude(),
        });
      }, { timeout: 60000 });
    }

    const pendingApproval =
      request.approvals.find(
        (approval) =>
          approval.approverUserId ===
            managerUserId &&
          approval.status === 'PENDING',
      );

    if (!pendingApproval) {
      throw new BadRequestException(
        'User cannot approve this employee transfer',
      );
    }

    if (!approve) {
      return this.prisma.$transaction(async (tx) => {
        await tx.employeeTransferApproval.update({
          where: {
            id: pendingApproval.id,
          },
          data: {
            status: 'REJECTED',
            note: rejectionReason || 'Rejected',
            reviewedAt: now,
          },
        });

        return tx.employeeTransferRequest.update({
          where: {
            id: transferId,
          },

          data: {
            status: 'REJECTED',
            rejectedAt: now,
            rejectionReason:
              rejectionReason || 'Rejected',
          },

          include: this.buildInclude(),
        });
      }, { timeout: 60000 });
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.employeeTransferApproval.update({
        where: {
          id: pendingApproval.id,
        },
        data: {
          status: 'APPROVED',
          reviewedAt: now,
        },
      });

      const approvals =
        await tx.employeeTransferApproval.findMany({
          where: {
            transferRequestId: transferId,
          },
        });

      const fullyApproved =
        approvals.every(
          (approval) =>
            approval.status === 'APPROVED',
        );

      if (!fullyApproved) {
        return tx.employeeTransferRequest.update({
          where: {
            id: transferId,
          },
          data: {
            status: 'PARTIALLY_APPROVED',
            reason: `Approval stage completed by manager ${managerUserId}`,
          },
          include: this.buildInclude(),
        });
      }

      await this.applyMultiProjectTransferState(tx, request);

      return tx.employeeTransferRequest.update({
        where: {
          id: transferId,
        },

        data: {
          status: 'APPROVED',
          approvedAt: now,
          appliedAt: now,
          effectiveDate: request.effectiveDate || now,
          reason: request.reason
            ? `${request.reason}; Final approval by manager ${managerUserId}`
            : `Approved by manager ${managerUserId}`,
        },

        include: this.buildInclude(),
      });
    }, { timeout: 60000 });
  }
}
