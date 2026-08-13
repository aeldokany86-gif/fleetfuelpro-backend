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

  private isAdminRole(roleName?: string) {
    const normalizedRole = this.normalizeRoleName(roleName);
    return (
      normalizedRole === 'admin' ||
      normalizedRole === 'platformuser' ||
      normalizedRole === 'platformadmin'
    );
  }

  private isManagerRole(roleName?: string) {
    return this.normalizeRoleName(roleName) === 'manager';
  }

  private isEmployeeMultiProjectRole(employee: any) {
    const linkedRole = this.normalizeRoleName(employee?.linkedUser?.role?.name);
    if (linkedRole) {
      return ['officer', 'supervisor', 'operator'].includes(linkedRole);
    }

    const jobTitle = this.normalizeRoleName(employee?.jobTitle);
    return !['admin', 'platformuser', 'platformadmin', 'manager', 'topmanagement'].includes(jobTitle);
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
    const company = companyId
      ? await this.prisma.company.findFirst({
          where: { id: companyId, deletedAt: null },
          select: { multiProjectEnabled: true },
        })
      : null;

    const multiProjectEnabled = Boolean(company?.multiProjectEnabled);

    const employees = await this.prisma.employee.findMany({
      where: {
        deletedAt: null,
        ...(companyId ? { companyId } : {}),
        ...(projectId
          ? multiProjectEnabled
            ? {
                OR: [
                  { projectId },
                  { projectAssignments: { some: { projectId } } },
                ],
              }
            : { projectId }
          : {}),
        ...(status ? { status: status as any } : {}),
      },
      include: {
        project: true,
        projectAssignments: {
          include: {
            project: {
              select: { id: true, name: true, code: true, isActive: true, deletedAt: true },
            },
          },
          orderBy: { assignedAt: 'asc' },
        },
        linkedUser: {
          select: {
            id: true,
            fullName: true,
            email: true,
            isActive: true,
            role: { select: { id: true, name: true } },
            managedProjects: {
              where: { deletedAt: null, isActive: true },
              select: { id: true, name: true, code: true },
              orderBy: { name: 'asc' },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return employees.map((employee: any) => {
      const linkedRole = this.normalizeRoleName(employee.linkedUser?.role?.name);
      const managerProjectCount =
        linkedRole === 'manager' ? employee.linkedUser?.managedProjects?.length || 0 : null;
      const additionalProjectCount = multiProjectEnabled
        ? employee.projectAssignments?.filter(
            (item: any) => item.project && !item.project.deletedAt && item.project.isActive,
          ).length || 0
        : 0;

      return {
        ...employee,
        multiProjectEnabled,
        assignedProjectsCount:
          managerProjectCount ?? ((employee.projectId ? 1 : 0) + additionalProjectCount),
      };
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
          company: { select: { id: true, name: true, multiProjectEnabled: true } },
          project: true,
          projectAssignments: {
            include: {
              project: {
                select: { id: true, name: true, code: true, isActive: true, deletedAt: true },
              },
            },
            orderBy: { assignedAt: 'asc' },
          },
          linkedUser: {
            select: {
              id: true,
              fullName: true,
              email: true,
              isActive: true,
              role: { select: { id: true, name: true } },
              managedProjects: {
                where: { deletedAt: null, isActive: true },
                select: { id: true, name: true, code: true },
                orderBy: { name: 'asc' },
              },
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

    const normalizedUpdatedName =
      updateEmployeeDto.name !== undefined
        ? updateEmployeeDto.name.trim()
        : undefined;

    const shouldSyncLinkedUserName =
      normalizedUpdatedName !== undefined &&
      Boolean(existing.linkedUserId);

    const shouldDeactivateLinkedUser =
      isRetiring &&
      Boolean(existing.linkedUserId);

    if (
      !shouldSyncLinkedUserName &&
      !shouldDeactivateLinkedUser
    ) {
      return employeeUpdate;
    }

    const userUpdateData: {
      fullName?: string;
      isActive?: boolean;
      deletedAt?: Date | null;
    } = {};

    if (shouldSyncLinkedUserName) {
      userUpdateData.fullName =
        normalizedUpdatedName;
    }

    if (shouldDeactivateLinkedUser) {
      userUpdateData.isActive = false;
      userUpdateData.deletedAt = retiredAt;
    }

    const [updatedEmployee] =
      await this.prisma.$transaction([
        employeeUpdate,
        this.prisma.user.updateMany({
          where: {
            id: existing.linkedUserId!,
            deletedAt: null,
          },
          data: userUpdateData,
        }),
      ]);

    return updatedEmployee;
  }

  private async getProjectAssignmentActor(
    actorUserId: string,
    actorCompanyId: string,
    actorRoleName: string,
  ) {
    const actor = await this.prisma.user.findFirst({
      where: {
        id: actorUserId,
        deletedAt: null,
        isActive: true,
      },
      include: {
        role: true,
        managedProjects: {
          where: { deletedAt: null, isActive: true },
          select: { id: true },
        },
      },
    });

    if (!actor) throw new BadRequestException('Authenticated user is invalid or inactive');

    const roleName = actor.role?.name || actorRoleName;
    if (!this.isAdminRole(roleName) && !this.isManagerRole(roleName)) {
      throw new BadRequestException('Only Admin or Manager can manage employee project assignments');
    }

    if (!this.isPlatformUser(roleName) && actor.companyId !== actorCompanyId) {
      throw new BadRequestException('Authenticated company does not match the requested company');
    }

    return { actor, roleName };
  }

  async getProjectAssignments(
    employeeId: string,
    actorUserId: string,
    actorCompanyId: string,
    actorRoleName: string,
  ) {
    const employee: any = await this.findOne(employeeId);
    const { actor, roleName } = await this.getProjectAssignmentActor(
      actorUserId,
      actorCompanyId,
      actorRoleName,
    );

    if (!this.isPlatformUser(roleName) && actor.companyId !== employee.companyId) {
      throw new BadRequestException('Employee belongs to a different company');
    }

    const targetRole = this.normalizeRoleName(employee.linkedUser?.role?.name);
    const actorIsManager = this.isManagerRole(roleName);
    const managerManagedIds = new Set((actor.managedProjects || []).map((project: any) => project.id));

    if (targetRole === 'manager') {
      if (actorIsManager && employee.linkedUser?.id !== actor.id) {
        throw new BadRequestException('Manager can view only their own managed-project assignment summary');
      }
      return {
        employeeId: employee.id,
        employeeCode: employee.employeeId,
        employeeName: employee.name,
        multiProjectEnabled: Boolean(employee.company?.multiProjectEnabled),
        assignmentMode: 'MANAGED_PROJECTS_READ_ONLY',
        readOnly: true,
        canManage: false,
        primaryProject: employee.project
          ? { id: employee.project.id, name: employee.project.name, code: employee.project.code }
          : null,
        additionalProjects: employee.linkedUser?.managedProjects || [],
        totalProjects: employee.linkedUser?.managedProjects?.length || 0,
      };
    }

    const multiProjectEnabled = Boolean(employee.company?.multiProjectEnabled);
    const managerOwnsPrimaryProject =
      !actorIsManager || (employee.projectId && managerManagedIds.has(employee.projectId));

    if (actorIsManager && !managerOwnsPrimaryProject) {
      throw new BadRequestException('Manager can access assignments only for employees whose primary project is managed by this Manager');
    }

    const canManage =
      multiProjectEnabled &&
      this.isEmployeeMultiProjectRole(employee) &&
      (this.isAdminRole(roleName) || (actorIsManager && Boolean(managerOwnsPrimaryProject)));

    return {
      employeeId: employee.id,
      employeeCode: employee.employeeId,
      employeeName: employee.name,
      multiProjectEnabled,
      assignmentMode: 'EMPLOYEE_PROJECT_ASSIGNMENTS',
      readOnly: !canManage,
      canManage,
      primaryProject: employee.project
        ? { id: employee.project.id, name: employee.project.name, code: employee.project.code }
        : null,
      additionalProjects: (employee.projectAssignments || [])
        .filter((item: any) => item.project && !item.project.deletedAt && item.project.isActive)
        .map((item: any) => ({
          assignmentId: item.id,
          id: item.project.id,
          name: item.project.name,
          code: item.project.code,
          assignedAt: item.assignedAt,
        })),
      totalProjects:
        (employee.projectId ? 1 : 0) +
        (multiProjectEnabled
          ? (employee.projectAssignments || []).filter(
              (item: any) => item.project && !item.project.deletedAt && item.project.isActive,
            ).length
          : 0),
    };
  }

  async addProjectAssignment(
    employeeId: string,
    projectId: string,
    actorUserId: string,
    actorCompanyId: string,
    actorRoleName: string,
  ) {
    const employee: any = await this.findOne(employeeId);
    const { actor, roleName } = await this.getProjectAssignmentActor(
      actorUserId,
      actorCompanyId,
      actorRoleName,
    );

    if (!employee.company?.multiProjectEnabled) {
      throw new BadRequestException('Multi-Project is not enabled for this company');
    }
    if (!this.isEmployeeMultiProjectRole(employee)) {
      throw new BadRequestException('Multi-Project assignment is allowed only for Officer, Supervisor, or Operator employees');
    }
    if (!this.isPlatformUser(roleName) && actor.companyId !== employee.companyId) {
      throw new BadRequestException('Employee belongs to a different company');
    }
    if (!projectId) throw new BadRequestException('Project is required');
    if (employee.projectId === projectId) {
      throw new BadRequestException('Primary project is already assigned to this employee');
    }

    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        companyId: employee.companyId,
        deletedAt: null,
        isActive: true,
      },
      select: { id: true, name: true, code: true, projectManagerId: true },
    });
    if (!project) throw new BadRequestException('Project must be active and belong to the employee company');

    if (this.isManagerRole(roleName)) {
      const managedIds = new Set((actor.managedProjects || []).map((item: any) => item.id));
      if (!employee.projectId || !managedIds.has(employee.projectId)) {
        throw new BadRequestException('Manager can manage assignments only for employees whose primary project is managed by this Manager');
      }
      if (!managedIds.has(project.id)) {
        throw new BadRequestException('Manager can assign only projects managed by this Manager');
      }
    }

    const existing = await this.prisma.employeeProjectAssignment.findUnique({
      where: { employeeId_projectId: { employeeId: employee.id, projectId: project.id } },
    });
    if (existing) throw new BadRequestException('Project is already linked to this employee');

    await this.prisma.employeeProjectAssignment.create({
      data: {
        companyId: employee.companyId,
        employeeId: employee.id,
        projectId: project.id,
        assignedByUserId: actor.id,
      },
    });

    return this.getProjectAssignments(
      employee.id,
      actor.id,
      actor.companyId,
      roleName,
    );
  }

  async removeProjectAssignments(
    employeeId: string,
    projectIds: string[],
    actorUserId: string,
    actorCompanyId: string,
    actorRoleName: string,
  ) {
    const employee: any = await this.findOne(employeeId);
    const { actor, roleName } = await this.getProjectAssignmentActor(
      actorUserId,
      actorCompanyId,
      actorRoleName,
    );

    if (!employee.company?.multiProjectEnabled) {
      throw new BadRequestException('Multi-Project is not enabled for this company');
    }
    if (!this.isEmployeeMultiProjectRole(employee)) {
      throw new BadRequestException('Multi-Project assignment is allowed only for Officer, Supervisor, or Operator employees');
    }
    if (!this.isPlatformUser(roleName) && actor.companyId !== employee.companyId) {
      throw new BadRequestException('Employee belongs to a different company');
    }

    const uniqueProjectIds = Array.from(
      new Set((Array.isArray(projectIds) ? projectIds : []).map((id) => String(id || '').trim()).filter(Boolean)),
    );
    if (!uniqueProjectIds.length) throw new BadRequestException('Select at least one additional project to remove');
    if (employee.projectId && uniqueProjectIds.includes(employee.projectId)) {
      throw new BadRequestException('Primary project cannot be removed from Multi-Project assignments');
    }

    if (this.isManagerRole(roleName)) {
      const managedIds = new Set((actor.managedProjects || []).map((item: any) => item.id));
      if (!employee.projectId || !managedIds.has(employee.projectId)) {
        throw new BadRequestException('Manager can manage assignments only for employees whose primary project is managed by this Manager');
      }
      if (uniqueProjectIds.some((id) => !managedIds.has(id))) {
        throw new BadRequestException('Manager can remove only projects managed by this Manager');
      }
    }

    await this.prisma.employeeProjectAssignment.deleteMany({
      where: {
        employeeId: employee.id,
        projectId: { in: uniqueProjectIds },
      },
    });

    return this.getProjectAssignments(
      employee.id,
      actor.id,
      actor.companyId,
      roleName,
    );
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
