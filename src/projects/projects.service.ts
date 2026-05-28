import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Injectable()
export class ProjectsService {
  constructor(private prisma: PrismaService) {}

  private normalizeCode(code: string) {
    return String(code || '').trim().toUpperCase();
  }

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

  async create(createProjectDto: CreateProjectDto) {
    const company = await this.prisma.company.findFirst({
      where: {
        id: createProjectDto.companyId,
        deletedAt: null,
      },
    });

    if (!company) {
      throw new BadRequestException('Company not found');
    }

    const projectCode = this.normalizeCode(createProjectDto.code);

    const existingProject = await this.prisma.project.findFirst({
      where: {
        companyId: createProjectDto.companyId,
        code: projectCode,
      },
    });

    if (existingProject) {
      if (existingProject.deletedAt) {
        throw new BadRequestException(
          'This Project ID was previously used and cannot be reused',
        );
      }

      throw new BadRequestException(
        'Project code already exists in this company',
      );
    }

    return this.prisma.project.create({
      data: {
        companyId: createProjectDto.companyId,
        code: projectCode,
        name: createProjectDto.name?.trim(),
        location: createProjectDto.location?.trim() || null,
        description: createProjectDto.description?.trim() || null,
        isActive: createProjectDto.isActive ?? true,
      },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        projectManager: {
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

  async findAll(companyId?: string) {
    return this.prisma.project.findMany({
      where: {
        deletedAt: null,
        ...(companyId ? { companyId } : {}),
      },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        projectManager: {
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

  async findOne(id: string) {
    const project = await this.prisma.project.findFirst({
      where: {
        id,
        deletedAt: null,
      },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        projectManager: {
          select: {
            id: true,
            fullName: true,
            email: true,
            isActive: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return project;
  }

  async update(id: string, updateProjectDto: UpdateProjectDto) {
    const existingProject = await this.prisma.project.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!existingProject) {
      throw new NotFoundException('Project not found');
    }

    const nextCompanyId =
      updateProjectDto.companyId ||
      existingProject.companyId;

    const nextCode =
      updateProjectDto.code
        ? this.normalizeCode(
            updateProjectDto.code,
          )
        : existingProject.code;

    if (
      nextCompanyId !==
        existingProject.companyId ||
      nextCode !== existingProject.code
    ) {
      const duplicateProject =
        await this.prisma.project.findFirst({
          where: {
            companyId:
              nextCompanyId,
            code: nextCode,
            NOT: {
              id,
            },
          },
        });

      if (duplicateProject) {
        if (
          duplicateProject.deletedAt
        ) {
          throw new BadRequestException(
            'This Project ID was previously used and cannot be reused',
          );
        }

        throw new BadRequestException(
          'Project code already exists in this company',
        );
      }
    }

    return this.prisma.project.update({
      where: { id },
      data: {
        ...(updateProjectDto.companyId !==
        undefined
          ? {
              companyId:
                updateProjectDto.companyId,
            }
          : {}),

        ...(updateProjectDto.code !==
        undefined
          ? {
              code: nextCode,
            }
          : {}),

        ...(updateProjectDto.name !==
        undefined
          ? {
              name:
                updateProjectDto.name.trim(),
            }
          : {}),

        ...(updateProjectDto.location !==
        undefined
          ? {
              location:
                updateProjectDto.location?.trim() ||
                null,
            }
          : {}),

        ...(updateProjectDto.description !==
        undefined
          ? {
              description:
                updateProjectDto.description?.trim() ||
                null,
            }
          : {}),

        ...(updateProjectDto.isActive !==
        undefined
          ? {
              isActive:
                updateProjectDto.isActive,
            }
          : {}),
      },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        projectManager: {
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

  async assignProjectManager(
    projectId: string,
    managerUserId: string,
    requestedByUserId?: string,
  ) {
    if (!managerUserId) {
      throw new BadRequestException(
        'Manager user is required',
      );
    }

    const project =
      await this.prisma.project.findFirst({
        where: {
          id: projectId,
          deletedAt: null,
        },
      });

    if (!project) {
      throw new NotFoundException(
        'Project not found',
      );
    }

    if (requestedByUserId) {
      const requester = await this.prisma.user.findFirst({
        where: {
          id: requestedByUserId,
          deletedAt: null,
          isActive: true,
          companyId: project.companyId,
        },
        include: {
          role: true,
        },
      });

      if (!requester || !this.isAdminRole(requester.role?.name || '')) {
        throw new BadRequestException(
          'Only Admin can approve Project Manager assignment',
        );
      }
    }

    const manager =
      await this.prisma.user.findFirst({
        where: {
          id: managerUserId,
          deletedAt: null,
          isActive: true,
          companyId:
            project.companyId,
        },
        include: {
          role: true,
          linkedEmployee: {
            select: {
              id: true,
              employeeId: true,
              name: true,
              status: true,
              deletedAt: true,
            },
          },
        },
      });

    if (!manager) {
      throw new BadRequestException(
        'Manager user not found',
      );
    }

    if (
      this.normalizeRoleName(
        manager.role?.name,
      ) !== 'MANAGER'
    ) {
      throw new BadRequestException(
        'Assigned user must have Manager role',
      );
    }

    if (
      manager.linkedEmployee &&
      (
        manager.linkedEmployee.deletedAt ||
        manager.linkedEmployee.status ===
          'RETIRED_RESIGNED'
      )
    ) {
      throw new BadRequestException(
        'Assigned manager employee profile is not active',
      );
    }

    return this.prisma.project.update({
      where: {
        id: projectId,
      },
      data: {
        projectManagerId:
          managerUserId,
      },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        projectManager: {
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
  
  async updateFuelPrice(
    projectId: string,
    data: {
      pricePerLiter: number;
      effectiveFrom?: string;
      reason?: string;
      createdByUserId?: string;
    },
  ) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        deletedAt: null,
      },
      include: {
        company: true,
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const pricePerLiter = Number(data.pricePerLiter);

    if (
      Number.isNaN(pricePerLiter) ||
      pricePerLiter <= 0
    ) {
      throw new BadRequestException(
        'Price per liter must be greater than zero',
      );
    }

    const effectiveFrom = data.effectiveFrom
      ? new Date(data.effectiveFrom)
      : new Date();

    const history =
      await this.prisma.projectFuelPriceHistory.create({
        data: {
          projectId: project.id,
          companyId: project.companyId,
          country:
            project.company?.country || 'Unknown',
          currency:
            project.company?.currency || 'SAR',
          pricePerLiter,
          effectiveFrom,
          reason: data.reason?.trim() || null,
          createdByUserId:
            data.createdByUserId || null,
        },
        include: {
          project: true,
          company: true,
          createdBy: true,
        },
      });

    const latestPrice =
      await this.prisma.projectFuelPriceHistory.findFirst({
        where: {
          projectId: project.id,
        },
        orderBy: {
          effectiveFrom: 'desc',
        },
      });

    await this.prisma.project.update({
      where: {
        id: project.id,
      },
      data: {
        currentFuelPrice:
          latestPrice?.pricePerLiter || 0,
        fuelPriceEffectiveFrom:
          latestPrice?.effectiveFrom || new Date(),
      },
    });

    return history;
  }

  async getFuelPriceHistory(projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        deletedAt: null,
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return this.prisma.projectFuelPriceHistory.findMany({
      where: {
        projectId,
      },
      include: {
        company: true,
        project: true,
        createdBy: true,
      },
      orderBy: {
        effectiveFrom: 'desc',
      },
    });
  }

  async getEffectiveFuelPrice(
    projectId: string,
    operationDate?: string,
  ) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        deletedAt: null,
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const targetDate = operationDate
      ? new Date(operationDate)
      : new Date();

    const price =
      await this.prisma.projectFuelPriceHistory.findFirst({
        where: {
          projectId,
          effectiveFrom: {
            lte: targetDate,
          },
        },
        orderBy: {
          effectiveFrom: 'desc',
        },
      });

    if (!price) {
      throw new NotFoundException(
        'No fuel price found for this date',
      );
    }

    return price;
  }
  async remove(id: string) {
    const existingProject =
      await this.prisma.project.findFirst({
        where: {
          id,
          deletedAt: null,
        },
      });

    if (!existingProject) {
      throw new NotFoundException(
        'Project not found',
      );
    }

    return this.prisma.project.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        isActive: false,
      },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        projectManager: {
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
}
