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
        roleName: user.role.name,
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
    const cleanIdentifier = this.normalizeIdentifier(identifier);

    if (!cleanIdentifier || !password) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [
          { username: cleanIdentifier },
          ...(cleanIdentifier.includes('@') ? [{ email: cleanIdentifier }] : []),
        ],
      },
      include: this.buildAuthInclude(),
    });

    if (!user || user.deletedAt) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const isPlatformUser = this.isPlatformRole(user.role?.name);

    // Company users must login by generated username: companyCode.employeeId.
    // Email remains available for Platform Console users and temporary backwards-compatible checks only.
    if (cleanIdentifier.includes('@') && !isPlatformUser) {
      throw new UnauthorizedException('Please login using your username');
    }

    if (!user.isActive) {
      throw new UnauthorizedException(
        'Your account is inactive. Please contact your administrator.',
      );
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const permissions = user.role.permissions.map(
      (rolePermission) => rolePermission.permission.key,
    );

    const payload = {
      sub: user.id,
      email: user.email,
      username: user.username,
      companyId: user.companyId,
      roleId: user.roleId,
      roleName: user.role.name,
      permissions,
    };

    const accessToken = await this.jwtService.signAsync(payload);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      access_token: accessToken,
      user: this.formatUserResponse(user, permissions),
    };
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

    return {
      success: true,
      user: this.formatUserResponse(updatedUser, permissions),
    };
  }

  async getMe(userId: string) {
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

    const permissions = user.role.permissions.map(
      (rolePermission) => rolePermission.permission.key,
    );

    return this.formatUserResponse(user, permissions);
  }

  private formatUserResponse(user: any, permissions: string[]) {
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
