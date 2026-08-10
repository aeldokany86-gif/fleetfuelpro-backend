import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { EmployeeCreationDomainService } from './employee-creation-domain.service';

@Injectable()
export class EmployeesService {
  constructor(
    private prisma: PrismaService,
    private readonly employeeCreationDomainService: EmployeeCreationDomainService,
  ) {}

  private normalizeRoleName(roleName?: string) {
    return String(roleName || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '');
  }

  private isPlatformUser(roleName?: string) {
    const normalizedRole = this.normalizeRoleName(roleName);

    return (
      normalizedRole === 'platformuser' ||
      normalizedRole === 'platformadmin'
    );
  }

  private normalizeEmployeeId(
    employeeId: string,
  ) {
    return this.employeeCreationDomainService.normalizeEmployeeId(
      employeeId,
    );
  }

  async checkEmployeeIdAvailability(
    employeeIdValue: string,
    requestedCompanyId: string | undefined,
    actorCompanyId: string,
    actorRoleName: string,
  ) {
    const employeeId = this.normalizeEmployeeId(employeeIdValue);

    if (!employeeId) {
      throw new BadRequestException('Employee ID is required');
    }

    const platformUser = this.isPlatformUser(actorRoleName);
    const targetCompanyId = platformUser
      ? requestedCompanyId
      : actorCompanyId;

    if (!targetCompanyId) {
      throw new BadRequestException('Company ID is required');
    }

    const duplicate = await this.prisma.employee.findFirst({
      where: {
        companyId: targetCompanyId,
        employeeId,
      },
      select: {
        id: true,
        deletedAt: true,
      },
    });

    if (!duplicate) {
      return {
        employeeId,
        available: true,
        status: 'AVAILABLE',
      };
    }

    return {
      employeeId,
      available: false,
      status: duplicate.deletedAt
        ? 'PREVIOUSLY_USED'
        : 'ACTIVE_DUPLICATE',
    };
  }

  async create(
    createEmployeeDto: CreateEmployeeDto,
    actorCompanyId: string,
    actorRoleName: string,
  ) {
    const platformUser = this.isPlatformUser(actorRoleName);
    const targetCompanyId = platformUser
      ? createEmployeeDto.companyId
      : actorCompanyId;

    if (!targetCompanyId) {
      throw new BadRequestException(
        'Company ID is required',
      );
    }

    const company =
      await this.prisma.company.findFirst({
        where: {
          id: targetCompanyId,
          deletedAt: null,
          isActive: true,
        },
      });

    if (!company) {
      throw new BadRequestException(
        'Company not found or inactive',
      );
    }

    let project: any = null;
    const isBootstrapEmployee =
      platformUser && !createEmployeeDto.projectId;

    if (isBootstrapEmployee) {
      const [
        existingEmployees,
        existingUsers,
        existingProjects,
      ] = await this.prisma.$transaction([
        this.prisma.employee.count({
          where: {
            companyId: targetCompanyId,
            deletedAt: null,
          },
        }),
        this.prisma.user.count({
          where: {
            companyId: targetCompanyId,
            deletedAt: null,
          },
        }),
        this.prisma.project.count({
          where: {
            companyId: targetCompanyId,
            deletedAt: null,
          },
        }),
      ]);

      if (
        existingEmployees > 0 ||
        existingUsers > 0 ||
        existingProjects > 0
      ) {
        throw new BadRequestException(
          'An employee without a project is allowed only as the first bootstrap Admin employee of a new company',
        );
      }
    } else {
      if (!createEmployeeDto.projectId) {
        throw new BadRequestException(
          'Employee must be assigned to an active project',
        );
      }

      project =
        await this.prisma.project.findFirst({
          where: {
            id: createEmployeeDto.projectId,
            companyId: targetCompanyId,
            deletedAt: null,
            isActive: true,
          },
        });

      if (!project) {
        throw new BadRequestException(
          'Project must be active and belong to the selected company',
        );
      }
    }

    const employeeId =
      this.normalizeEmployeeId(
        createEmployeeDto.employeeId,
      );

    const duplicate =
      await this.prisma.employee.findFirst({
        where: {
          companyId:
            targetCompanyId,
          employeeId,
        },
      });

    if (duplicate) {
      throw new BadRequestException(
        duplicate.deletedAt
          ? 'This Employee ID was previously used and cannot be reused'
          : 'Employee ID already exists',
      );
    }

    return this.employeeCreationDomainService.createEmployee(
      this.prisma,
      {
        companyId: targetCompanyId,
        employeeId,
        name: createEmployeeDto.name,
        phone: createEmployeeDto.phone,
        email: createEmployeeDto.email,
        projectId: project?.id || null,
        linkedUserId: createEmployeeDto.linkedUserId || null,
        jobTitle: isBootstrapEmployee
          ? 'Company Admin'
          : createEmployeeDto.jobTitle || 'Operator',
        status:
          createEmployeeDto.status ||
          'ON_DUTY',
      },
    );
  }

  async findAll(
    companyId?: string,
    projectId?: string,
    status?: string,
  ) {
    return this.prisma.employee.findMany({
      where: {
        deletedAt: null,

        ...(companyId
          ? { companyId }
          : {}),

        ...(projectId
          ? { projectId }
          : {}),

        ...(status
          ? { status: status as any }
          : {}),
      },

      include: {
        project: true,

        linkedUser: {
          select: {
            id: true,
            fullName: true,
            email: true,
            isActive: true,
          },
        },
      },

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async getActiveProjects(
    companyId: string,
  ) {
    if (!companyId) {
      throw new BadRequestException(
        'Company ID is required',
      );
    }

    return this.prisma.project.findMany({
      where: {
        companyId,
        deletedAt: null,
        isActive: true,
      },

      select: {
        id: true,
        name: true,
        code: true,
      },

      orderBy: {
        name: 'asc',
      },
    });
  }

  async getMasterReport(filters: {
    companyId: string;
    projectId?: string;
    status?: string;
    jobTitle?: string;
    employeeCode?: string;
    linkedStatus?: string;
  }) {
    if (!filters.companyId) {
      throw new BadRequestException('Company ID is required');
    }

    const linkedStatus = String(filters.linkedStatus || '').toUpperCase();
    const employees = await this.prisma.employee.findMany({
      where: {
        companyId: filters.companyId,
        ...(filters.projectId ? { projectId: filters.projectId } : {}),
        ...(filters.status ? { status: filters.status as any } : {}),
        ...(filters.jobTitle
          ? { jobTitle: { equals: filters.jobTitle, mode: 'insensitive' } }
          : {}),
        ...(filters.employeeCode
          ? {
              employeeId: {
                contains: filters.employeeCode.trim(),
                mode: 'insensitive',
              },
            }
          : {}),
        ...(linkedStatus === 'LINKED' ? { linkedUserId: { not: null } } : {}),
        ...(linkedStatus === 'NOT_LINKED' ? { linkedUserId: null } : {}),
      },
      include: {
        company: { select: { id: true, name: true } },
        project: { select: { id: true, name: true, code: true } },
        linkedUser: {
          select: {
            id: true,
            fullName: true,
            email: true,
            isActive: true,
            deletedAt: true,
            role: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ employeeId: 'asc' }],
    });

    const rows = employees.map((employee) => ({
      id: employee.id,
      companyId: employee.companyId,
      companyName: employee.company.name,
      employeeCode: employee.employeeId,
      employeeName: employee.name,
      phone: employee.phone,
      email: employee.email,
      jobTitle: employee.jobTitle,
      status: employee.status,
      projectId: employee.projectId,
      projectName:
        employee.project?.name || employee.project?.code || null,
      isDeleted: Boolean(employee.deletedAt),
      deletedAt: employee.deletedAt,
      linkedUserId: employee.linkedUserId,
      userLinked: Boolean(employee.linkedUserId),
      linkedUserName: employee.linkedUser?.fullName || null,
      linkedUserRole: employee.linkedUser?.role?.name || null,
      linkedUserActive: employee.linkedUser
        ? employee.linkedUser.isActive && !employee.linkedUser.deletedAt
        : false,
      createdAt: employee.createdAt,
      updatedAt: employee.updatedAt,
    }));

    return {
      summary: {
        total: rows.length,
        onDuty: rows.filter((row) => row.status === 'ON_DUTY').length,
        onVacation: rows.filter((row) => row.status === 'VACATION').length,
        retiredResigned: rows.filter(
          (row) => row.status === 'RETIRED_RESIGNED',
        ).length,
        linkedUsers: rows.filter((row) => row.userLinked).length,
      },
      rows,
    };
  }

  async findOne(
    id: string,
  ) {
    const employee =
      await this.prisma.employee.findFirst({
        where: {
          id,
          deletedAt: null,
        },

        include: {
          project: true,

          linkedUser: {
            select: {
              id: true,
              fullName: true,
              email: true,
              isActive: true,
            },
          },
        },
      });

    if (!employee) {
      throw new NotFoundException(
        'Employee not found',
      );
    }

    return employee;
  }

  async update(
    id: string,
    updateEmployeeDto: UpdateEmployeeDto,
  ) {
    const existing =
      await this.findOne(id);

    const isRetiring =
      updateEmployeeDto.status ===
      'RETIRED_RESIGNED';
    const retiredAt = isRetiring
      ? new Date()
      : null;

    if (
      updateEmployeeDto.projectId !== undefined &&
      updateEmployeeDto.projectId !==
        existing.projectId
    ) {
      throw new BadRequestException(
        'Employee transfer requires approval workflow',
      );
    }

    const employeeUpdate =
      this.prisma.employee.update({
      where: {
        id: existing.id,
      },

      data: {
        ...(isRetiring
          ? {
              deletedAt: retiredAt,
            }
          : {}),

        ...(updateEmployeeDto.name !==
        undefined
          ? {
              name:
                updateEmployeeDto.name.trim(),
            }
          : {}),

        ...(updateEmployeeDto.phone !==
        undefined
          ? {
              phone:
                updateEmployeeDto.phone?.trim() ||
                null,
            }
          : {}),

        ...(updateEmployeeDto.email !==
        undefined
          ? {
              email:
                updateEmployeeDto.email?.trim() ||
                null,
            }
          : {}),

        ...(updateEmployeeDto.status !==
        undefined
          ? {
              status:
                updateEmployeeDto.status,
            }
          : {}),

        ...(updateEmployeeDto.linkedUserId !==
        undefined
          ? {
              linkedUserId:
                updateEmployeeDto.linkedUserId ||
                null,
            }
          : {}),

        ...(updateEmployeeDto.jobTitle !==
        undefined
          ? {
              jobTitle:
                updateEmployeeDto.jobTitle ||
                'Operator',
            }
          : {}),
      },

      include: {
        project: true,

        linkedUser: {
          select: {
            id: true,
            fullName: true,
            email: true,
            isActive: true,
          },
        },
      },
    });

    if (
      !isRetiring ||
      !existing.linkedUserId
    ) {
      return employeeUpdate;
    }

    const [updatedEmployee] =
      await this.prisma.$transaction([
        employeeUpdate,
        this.prisma.user.updateMany({
          where: {
            id: existing.linkedUserId,
            deletedAt: null,
          },
          data: {
            isActive: false,
            deletedAt: retiredAt,
          },
        }),
      ]);

    return updatedEmployee;
  }

  async remove(
    id: string,
  ) {
    const existing =
      await this.findOne(id);
    const retiredAt = new Date();

    const employeeUpdate =
      this.prisma.employee.update({
      where: {
        id,
      },

      data: {
        deletedAt: retiredAt,

        status:
          'RETIRED_RESIGNED',
      },
    });

    if (!existing.linkedUserId) {
      return employeeUpdate;
    }

    const [retiredEmployee] =
      await this.prisma.$transaction([
        employeeUpdate,
        this.prisma.user.updateMany({
          where: {
            id: existing.linkedUserId,
            deletedAt: null,
          },
          data: {
            isActive: false,
            deletedAt: retiredAt,
          },
        }),
      ]);

    return retiredEmployee;
  }
}
