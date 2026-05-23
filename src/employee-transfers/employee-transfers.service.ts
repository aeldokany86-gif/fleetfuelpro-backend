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

  private isAdminRole(roleName: string) {
    const normalized = this.normalizeRoleName(roleName);
    return normalized === 'ADMIN' || normalized === 'PLATFORMADMIN' || normalized === 'PLATFORMUSER';
  }

  private isManagerTransfer(request: any) {
    const reason = String(request?.reason || '').toUpperCase();
    const employeeRoleName = this.normalizeRoleName(
      request?.employee?.linkedUser?.role?.name || request?.employee?.jobTitle || '',
    );

    return reason.includes('MANAGER_TRANSFER_ADMIN_APPROVAL') || employeeRoleName === 'MANAGER';
  }

  private async assertAdminApprover(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        deletedAt: null,
        isActive: true,
      },
      include: {
        role: true,
      },
    });

    if (!user || !this.isAdminRole(user.role?.name || '')) {
      throw new BadRequestException(
        'Only Admin can approve manager transfer',
      );
    }

    return user;
  }

  async createTransferRequest(
    employeeId: string,
    toProjectId: string,
    requestedByUserId: string,
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

    if (
      employee.projectId ===
      toProjectId
    ) {
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
          companyId:
            employee.companyId,
        },
      });

    if (!targetProject) {
      throw new BadRequestException(
        'Target project is invalid',
      );
    }

    const pending =
      await this.prisma.employeeTransferRequest.findFirst(
        {
          where: {
            employeeId,
            status: {
              in: [
                'PENDING',
                'PARTIALLY_APPROVED',
              ],
            },
          },
        },
      );

    if (pending) {
      throw new BadRequestException(
        'Pending transfer already exists',
      );
    }

    const employeeRoleName = String(
      employee.linkedUser?.role?.name ||
        employee.jobTitle ||
        '',
    )
      .trim()
      .toUpperCase();

    const isManagerTransfer =
      employeeRoleName === 'MANAGER';

    if (isManagerTransfer) {
      const activeAdmin = await this.prisma.user.findFirst({
        where: {
          companyId: employee.companyId,
          deletedAt: null,
          isActive: true,
          role: {
            is: {
              name: {
                in: ['Admin', 'ADMIN', 'PlatformAdmin', 'Platform User'],
              },
            },
          },
        },
      });

      if (!activeAdmin) {
        throw new BadRequestException(
          'Manager transfer requires an active Admin approver',
        );
      }
    } else if (
      !employee.project?.projectManagerId ||
      !targetProject.projectManagerId
    ) {
      throw new BadRequestException(
        'Employee transfer requires approval workflow',
      );
    }

    return this.prisma.employeeTransferRequest.create(
      {
        data: {
          companyId:
            employee.companyId,

          employeeId,

          fromProjectId:
            employee.projectId,

          toProjectId,

          requestedByUserId,

          status:
            'PENDING',

          reason: isManagerTransfer
            ? 'MANAGER_TRANSFER_ADMIN_APPROVAL'
            : null,
        },

        include: {
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
        },
      },
    );
  }

  async getPendingRequests() {
    return this.prisma.employeeTransferRequest.findMany(
      {
        where: {
          status: {
            in: [
              'PENDING',
              'PARTIALLY_APPROVED',
            ],
          },
        },

        include: {
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
        },

        orderBy: {
          createdAt:
            'desc',
        },
      },
    );
  }

  async reviewTransfer(
    transferId: string,
    managerUserId: string,
    approve: boolean,
    rejectionReason?: string,
  ) {
    const request =
      await this.prisma.employeeTransferRequest.findFirst(
        {
          where: {
            id: transferId,
          },

          include: {
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
          },
        },
      );

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

    const fromManagerId =
      request.fromProject?.projectManagerId;

    const toManagerId =
      request.toProject?.projectManagerId;

    const isManagerTransfer = this.isManagerTransfer(request);

    if (isManagerTransfer) {
      await this.assertAdminApprover(managerUserId);
    } else {
      const allowed =
        [
          fromManagerId,
          toManagerId,
        ].includes(
          managerUserId,
        );

      if (!allowed) {
        throw new BadRequestException(
          'User cannot approve this transfer',
        );
      }
    }

    if (!approve) {
      return this.prisma.employeeTransferRequest.update(
        {
          where: {
            id:
              transferId,
          },

          data: {
            status:
              'REJECTED',

            rejectedAt:
              new Date(),

            rejectionReason:
              rejectionReason ||
              'Rejected',
          },

          include: {
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
          },
        },
      );
    }

    const sameManagerForBothProjects =
      fromManagerId &&
      toManagerId &&
      fromManagerId === toManagerId;

    const shouldApplyTransfer =
      isManagerTransfer ||
      request.status ===
        'PARTIALLY_APPROVED' ||
      sameManagerForBothProjects;

    if (!shouldApplyTransfer) {
      return this.prisma.employeeTransferRequest.update(
        {
          where: {
            id:
              transferId,
          },

          data: {
            status:
              'PARTIALLY_APPROVED',

            reason:
              `First approval by manager ${managerUserId}`,
          },

          include: {
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
          },
        },
      );
    }

    await this.prisma.employee.update(
      {
        where: {
          id:
            request.employeeId,
        },

        data: {
          projectId:
            request.toProjectId,
        },
      },
    );

    return this.prisma.employeeTransferRequest.update(
      {
        where: {
          id:
            transferId,
        },

        data: {
          status:
            'APPROVED',

          approvedAt:
            new Date(),

          appliedAt:
            new Date(),

          reason:
            isManagerTransfer
              ? `Manager transfer approved by Admin ${managerUserId}`
              : request.reason
              ? `${request.reason}; Final approval by manager ${managerUserId}`
              : `Approved by manager ${managerUserId}`,
        },

        include: {
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
        },
      },
    );
  }
}
