import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  private createPerformanceTracker(scope: string) {
    const requestId = `${scope}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const startedAt = Date.now();
    let checkpointAt = startedAt;
    const stages: Record<string, number> = {};

    return {
      mark: (stage: string) => {
        const now = Date.now();
        stages[stage] = now - checkpointAt;
        checkpointAt = now;
      },
      finish: (extra: Record<string, unknown> = {}) => {
        const totalMs = Date.now() - startedAt;

        console.log(
          `[PERF][${requestId}]`,
          JSON.stringify({
            scope,
            totalMs,
            stages,
            ...extra,
          }),
        );

        return totalMs;
      },
    };
  }

  private normalizeRoleName(roleName: string) {
    return String(roleName || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '');
  }

  private isPlatformRole(roleName: string) {
    const normalizedRole = this.normalizeRoleName(roleName);

    return normalizedRole === 'platformuser' || normalizedRole === 'platformadmin';
  }

  private async getFirstProjectSetupState(user: any) {
    const normalizedRole = this.normalizeRoleName(user?.role?.name || '');

    if (
      normalizedRole !== 'admin' ||
      !user?.companyId ||
      !user?.linkedEmployee ||
      user.linkedEmployee.projectId
    ) {
      return {
        requiresFirstProject: false,
        requiredSetupStep: null,
      };
    }

    const totalProjectRecords = await this.prisma.project.count({
      where: {
        companyId: user.companyId,
      },
    });

    const requiresFirstProject = totalProjectRecords === 0;

    return {
      requiresFirstProject,
      requiredSetupStep: requiresFirstProject
        ? 'CREATE_FIRST_PROJECT'
        : null,
    };
  }

  private normalizeIdentifier(identifier?: string) {
    return String(identifier || '')
      .trim()
      .toLowerCase();
  }

  private buildAuthInclude() {
    return {
      company: true,
      role: {
        include: {
          permissions: {
            include: {
              permission: true,
            },
          },
        },
      },
      linkedEmployee: {
        include: {
          project: true,
        },
      },
      managedProjects: {
        where: {
          deletedAt: null,
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          code: true,
        },
      },
    };
  }

  private async loadAuthRelationsSeparately(
    userId: string,
    performance: ReturnType<AuthService['createPerformanceTracker']>,
  ) {
    const relationStartedAt = Date.now();

    const [
      companyResult,
      roleResult,
      linkedEmployeeResult,
      managedProjectsResult,
    ] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          company: true,
        },
      }),

      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          role: {
            include: {
              permissions: {
                include: {
                  permission: true,
                },
              },
            },
          },
        },
      }),

      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          linkedEmployee: {
            include: {
              project: true,
            },
          },
        },
      }),

      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          managedProjects: {
            where: {
              deletedAt: null,
              isActive: true,
            },
            select: {
              id: true,
              name: true,
              code: true,
            },
          },
        },
      }),
    ]);

    performance.mark('relations.parallel');

    console.log(
      '[PERF][auth.relations.parallel]',
      JSON.stringify({
        userId,
        totalMs: Date.now() - relationStartedAt,
        companyLoaded: Boolean(companyResult?.company),
        roleLoaded: Boolean(roleResult?.role),
        linkedEmployeeLoaded: Boolean(
          linkedEmployeeResult?.linkedEmployee,
        ),
        managedProjectCount:
          managedProjectsResult?.managedProjects?.length || 0,
      }),
    );

    return {
      company: companyResult?.company || null,
      role: roleResult?.role || null,
      linkedEmployee: linkedEmployeeResult?.linkedEmployee || null,
      managedProjects: managedProjectsResult?.managedProjects || [],
    };
  }

  private async findAuthUserCoreByIdentifier(
    cleanIdentifier: string,
    performance: ReturnType<AuthService['createPerformanceTracker']>,
  ) {
    const user = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [
          { username: cleanIdentifier },
          ...(cleanIdentifier.includes('@') ? [{ email: cleanIdentifier }] : []),
        ],
      },
      select: {
        id: true,
        fullName: true,
        username: true,
        email: true,
        phone: true,
        passwordHash: true,
        companyId: true,
        roleId: true,
        employeeId: true,
        isActive: true,
        mustChangePassword: true,
        lastLoginAt: true,
        deletedAt: true,
      },
    });

    performance.mark('core.user.findFirst');

    return user;
  }

  private async findAuthUserCoreById(
    userId: string,
    performance: ReturnType<AuthService['createPerformanceTracker']>,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        username: true,
        email: true,
        phone: true,
        passwordHash: true,
        companyId: true,
        roleId: true,
        employeeId: true,
        isActive: true,
        mustChangePassword: true,
        lastLoginAt: true,
        deletedAt: true,
      },
    });

    performance.mark('core.user.findUnique');

    return user;
  }

  async getLoginCompany(identifier: string) {
    const cleanIdentifier = this.normalizeIdentifier(identifier);

    if (!cleanIdentifier) {
      throw new BadRequestException('Please enter a username or email first.');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [
          { username: cleanIdentifier },
          ...(cleanIdentifier.includes('@') ? [{ email: cleanIdentifier }] : []),
        ],
      },
      include: {
        company: true,
        role: true,
      },
    });

    if (!user || user.deletedAt) {
      throw new UnauthorizedException('Invalid username or password');
    }

    if (!user.isActive) {
      throw new UnauthorizedException(
        'Your account is inactive. Please contact your administrator.',
      );
    }

    const isPlatformUser = this.isPlatformRole(user.role?.name);

    if (isPlatformUser) {
      const companies = await this.prisma.company.findMany({
        where: {
          deletedAt: null,
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          code: true,
          isActive: true,
        },
        orderBy: {
          name: 'asc',
        },
      });

      return {
        email: user.email,
        username: user.username,
        companyId: 'PLATFORM',
        companyName: 'Platform Console',
        roleName: user.role?.name || '',
        isPlatformUser: true,
        companies,
      };
    }

    return {
      email: user.email,
      username: user.username,
      companyId: user.companyId,
      companyName: user.company?.name || '',
      roleName: user.role?.name || '',
      isPlatformUser: false,
      companies: [],
    };
  }

  async login(identifier: string, password: string) {
    const performance = this.createPerformanceTracker('auth.login.isolated');
    const cleanIdentifier = this.normalizeIdentifier(identifier);

    performance.mark('normalizeIdentifier');

    if (!cleanIdentifier || !password) {
      performance.finish({
        success: false,
        reason: 'missing_credentials',
      });
      throw new UnauthorizedException('Invalid username or password');
    }

    try {
      const coreUser = await this.findAuthUserCoreByIdentifier(
        cleanIdentifier,
        performance,
      );

      if (!coreUser || coreUser.deletedAt) {
        performance.finish({
          success: false,
          reason: 'user_not_found',
        });
        throw new UnauthorizedException('Invalid username or password');
      }

      const relations = await this.loadAuthRelationsSeparately(
        coreUser.id,
        performance,
      );

      if (!relations.role) {
        performance.finish({
          success: false,
          reason: 'role_not_found',
          userId: coreUser.id,
        });
        throw new UnauthorizedException('Invalid username or password');
      }

      const user = {
        ...coreUser,
        ...relations,
      };

      const role = relations.role;

      const isPlatformUser = this.isPlatformRole(role.name);

      performance.mark('validateUserRecord');

      if (cleanIdentifier.includes('@') && !isPlatformUser) {
        performance.finish({
          success: false,
          reason: 'company_user_used_email',
          userId: user.id,
        });
        throw new UnauthorizedException('Please login using your username');
      }

      if (!user.isActive) {
        performance.finish({
          success: false,
          reason: 'inactive_user',
          userId: user.id,
        });
        throw new UnauthorizedException(
          'Your account is inactive. Please contact your administrator.',
        );
      }

      const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

      performance.mark('bcrypt.compare');

      if (!isPasswordValid) {
        performance.finish({
          success: false,
          reason: 'invalid_password',
          userId: user.id,
        });
        throw new UnauthorizedException('Invalid username or password');
      }

      const permissions = role.permissions.map(
        (rolePermission) => rolePermission.permission.key,
      );

      performance.mark('buildPermissions');

      const payload = {
        sub: user.id,
        email: user.email,
        username: user.username,
        companyId: user.companyId,
        roleId: user.roleId,
        roleName: role.name,
        permissions,
      };

      const accessToken = await this.jwtService.signAsync(payload);

      performance.mark('jwt.signAsync');

      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      performance.mark('prisma.user.updateLastLogin');

      const setupState = await this.getFirstProjectSetupState({
        ...user,
        role,
      });

      performance.mark('resolveFirstProjectSetup');

      const formattedUser = this.formatUserResponse(
        {
          ...user,
          role,
        },
        permissions,
        setupState,
      );

      performance.mark('formatUserResponse');

      performance.finish({
        success: true,
        userId: user.id,
        roleName: user.role?.name || '',
        permissionCount: permissions.length,
        managedProjectCount: Array.isArray(user.managedProjects)
          ? user.managedProjects.length
          : 0,
        hasLinkedEmployee: Boolean(user.linkedEmployee),
      });

      return {
        access_token: accessToken,
        user: formattedUser,
      };
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) {
        performance.finish({
          success: false,
          reason: 'unexpected_error',
          errorName: error?.constructor?.name || 'Error',
          errorMessage:
            error instanceof Error ? error.message : String(error || ''),
        });
      }

      throw error;
    }
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    if (!currentPassword || !newPassword) {
      throw new BadRequestException('Current password and new password are required');
    }

    if (String(newPassword).length < 8) {
      throw new BadRequestException('New password must be at least 8 characters');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: this.buildAuthInclude(),
    });

    if (!user || user.deletedAt) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.isActive) {
      throw new UnauthorizedException(
        'Your account is inactive. Please contact your administrator.',
      );
    }

    const isCurrentPasswordValid = await bcrypt.compare(
      currentPassword,
      user.passwordHash,
    );

    if (!isCurrentPasswordValid) {
      throw new BadRequestException('Current password is not correct');
    }

    const isSamePassword = await bcrypt.compare(
      newPassword,
      user.passwordHash,
    );

    if (isSamePassword) {
      throw new BadRequestException(
        'New password must be different from the temporary password',
      );
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        mustChangePassword: false,
      },
      include: this.buildAuthInclude(),
    });

    const permissions = updatedUser.role.permissions.map(
      (rolePermission) => rolePermission.permission.key,
    );

    const setupState =
      await this.getFirstProjectSetupState(updatedUser);

    return {
      success: true,
      user: this.formatUserResponse(
        updatedUser,
        permissions,
        setupState,
      ),
    };
  }

  async getMe(userId: string) {
    const performance = this.createPerformanceTracker('auth.getMe.isolated');

    try {
      const coreUser = await this.findAuthUserCoreById(userId, performance);

      if (!coreUser || coreUser.deletedAt) {
        performance.finish({
          success: false,
          reason: 'user_not_found',
          userId,
        });
        throw new UnauthorizedException('User not found');
      }

      const relations = await this.loadAuthRelationsSeparately(
        coreUser.id,
        performance,
      );

      if (!relations.role) {
        performance.finish({
          success: false,
          reason: 'role_not_found',
          userId,
        });
        throw new UnauthorizedException('User role not found');
      }

      const user = {
        ...coreUser,
        ...relations,
      };

      const role = relations.role;

      if (!user.isActive) {
        performance.finish({
          success: false,
          reason: 'inactive_user',
          userId,
        });
        throw new UnauthorizedException(
          'Your account is inactive. Please contact your administrator.',
        );
      }

      const permissions = role.permissions.map(
        (rolePermission) => rolePermission.permission.key,
      );

      performance.mark('buildPermissions');

      const setupState = await this.getFirstProjectSetupState({
        ...user,
        role,
      });

      performance.mark('resolveFirstProjectSetup');

      const response = this.formatUserResponse(
        {
          ...user,
          role,
        },
        permissions,
        setupState,
      );

      performance.mark('formatUserResponse');

      performance.finish({
        success: true,
        userId: user.id,
        roleName: user.role?.name || '',
        permissionCount: permissions.length,
        managedProjectCount: Array.isArray(user.managedProjects)
          ? user.managedProjects.length
          : 0,
        hasLinkedEmployee: Boolean(user.linkedEmployee),
      });

      return response;
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) {
        performance.finish({
          success: false,
          reason: 'unexpected_error',
          errorName: error?.constructor?.name || 'Error',
          errorMessage:
            error instanceof Error ? error.message : String(error || ''),
        });
      }

      throw error;
    }
  }

  private formatUserResponse(
    user: any,
    permissions: string[],
    setupState: {
      requiresFirstProject: boolean;
      requiredSetupStep: string | null;
    } = {
      requiresFirstProject: false,
      requiredSetupStep: null,
    },
  ) {
    const roleName = String(user.role?.name || '');
    const normalizedRole = roleName
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '');

    const isAllProjectsRole =
      normalizedRole === 'admin' ||
      normalizedRole === 'platformadmin' ||
      normalizedRole === 'platformuser' ||
      normalizedRole === 'topmanagement';

    const employeeProject = user.linkedEmployee?.project;

    const assignedProjects = isAllProjectsRole
      ? ['All']
      : employeeProject
        ? [
            employeeProject.id,
            employeeProject.name,
            employeeProject.code,
          ].filter(Boolean)
        : [];

    const managedProjects =
      isAllProjectsRole
        ? ['All']
        : normalizedRole === 'manager'
          ? (user.managedProjects || [])
              .flatMap((project) => [project.id, project.name, project.code])
              .filter(Boolean)
          : [];

    return {
      id: user.id,
      fullName: user.fullName,
      username: user.username || '',
      email: user.email,
      phone: user.phone,
      companyId: user.companyId,
      companyName: user.company?.name || '',
      roleId: user.roleId,
      roleName: user.role?.name || '',
      permissions,
      isActive: user.isActive,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt || null,
      requiresFirstProject: setupState.requiresFirstProject,
      requiredSetupStep: setupState.requiredSetupStep,

      // Operational scope resolved from backend relations.
      // User = identity/access, Employee = operational project assignment.
      linkedEmployeeId: user.linkedEmployee?.id || '',
      employeeId: user.linkedEmployee?.employeeId || user.employeeId || '',
      teamId: user.linkedEmployee?.id || '',
      fuelerId: user.linkedEmployee?.employeeId || user.linkedEmployee?.id || '',
      teamStatus: user.linkedEmployee?.status || '',
      teamProject: employeeProject?.name || employeeProject?.code || user.company?.name || '',
      assignedProjects,
      managedProjects,
      linkedEmployee: user.linkedEmployee
        ? {
            id: user.linkedEmployee.id,
            employeeId: user.linkedEmployee.employeeId,
            name: user.linkedEmployee.name,
            email: user.linkedEmployee.email,
            phone: user.linkedEmployee.phone,
            status: user.linkedEmployee.status,
            projectId: user.linkedEmployee.projectId,
            projectName: employeeProject?.name || '',
            projectCode: employeeProject?.code || '',
          }
        : null,
    };
  }
}
