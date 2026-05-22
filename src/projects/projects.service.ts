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
      .toUpperCase();
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
