import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

@Injectable()
export class EmployeesService {
  constructor(
    private prisma: PrismaService,
  ) {}

  private normalizeEmployeeId(
    employeeId: string,
  ) {
    return String(employeeId || '')
      .trim()
      .toUpperCase();
  }

  async create(
    createEmployeeDto: CreateEmployeeDto,
  ) {
    const company =
      await this.prisma.company.findFirst({
        where: {
          id: createEmployeeDto.companyId,
          deletedAt: null,
        },
      });

    if (!company) {
      throw new BadRequestException(
        'Company not found',
      );
    }

    if (!createEmployeeDto.projectId) {
      throw new BadRequestException(
        'Employee must be assigned to an active project',
      );
    }

    const project =
      await this.prisma.project.findFirst({
        where: {
          id: createEmployeeDto.projectId,
          companyId:
            createEmployeeDto.companyId,
          deletedAt: null,
          isActive: true,
        },
      });

    if (!project) {
      throw new BadRequestException(
        'Project must be active',
      );
    }

    const employeeId =
      this.normalizeEmployeeId(
        createEmployeeDto.employeeId,
      );

    const duplicate =
      await this.prisma.employee.findFirst({
        where: {
          companyId:
            createEmployeeDto.companyId,
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

    return this.prisma.employee.create({
      data: {
        companyId:
          createEmployeeDto.companyId,

        employeeId,

        name:
          createEmployeeDto.name?.trim(),

        phone:
          createEmployeeDto.phone?.trim() ||
          null,

        email:
          createEmployeeDto.email?.trim() ||
          null,

        projectId:
          createEmployeeDto.projectId,

        linkedUserId:
          createEmployeeDto.linkedUserId ||
          null,

        jobTitle:
          createEmployeeDto.jobTitle ||
          'Operator',

        status:
          createEmployeeDto.status ||
          'ON_DUTY',
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

    if (
      updateEmployeeDto.projectId !== undefined &&
      updateEmployeeDto.projectId !==
        existing.projectId
    ) {
      throw new BadRequestException(
        'Employee transfer requires approval workflow',
      );
    }

    return this.prisma.employee.update({
      where: {
        id: existing.id,
      },

      data: {
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
  }

  async remove(
    id: string,
  ) {
    await this.findOne(id);

    return this.prisma.employee.update({
      where: {
        id,
      },

      data: {
        deletedAt:
          new Date(),

        status:
          'RETIRED_RESIGNED',
      },
    });
  }
}
