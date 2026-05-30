import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

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
    };
  }

  async createTransferRequest(
    employeeId: string,
    toProjectId: string,
    requestedByUserId: string,
    effectiveDate?: string | Date | null,
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

      await tx.employee.update({
        where: {
          id: employee.id,
        },
        data: {
          projectId: toProjectId,
        },
      });

      return tx.employeeTransferRequest.findFirst({
        where: {
          id: transferRequest.id,
        },
        include: this.buildInclude(),
      });
    }, { timeout: 20000 });
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
        }, { timeout: 20000 });
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

        await tx.employee.update({
          where: {
            id: request.employeeId,
          },
          data: {
            projectId: request.toProjectId,
          },
        });

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
      }, { timeout: 20000 });
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
      }, { timeout: 20000 });
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

      await tx.employee.update({
        where: {
          id: request.employeeId,
        },
        data: {
          projectId: request.toProjectId,
        },
      });

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
    }, { timeout: 20000 });
  }
}
