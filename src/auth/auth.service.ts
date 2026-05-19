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

  private isPlatformRole(roleName: string) {
    const normalizedRole = String(roleName || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '');

    return normalizedRole === 'platformuser' || normalizedRole === 'platformadmin';
  }

  async getLoginCompany(email: string) {
    const cleanEmail = String(email || '').trim().toLowerCase();

    if (!cleanEmail || !cleanEmail.includes('@')) {
      throw new BadRequestException('Please enter a valid email first.');
    }

    const user = await this.prisma.user.findUnique({
      where: { email: cleanEmail },
      include: {
        company: true,
        role: true,
      },
    });

    if (!user || user.deletedAt) {
      throw new UnauthorizedException('Invalid email or password');
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
        companyId: 'PLATFORM',
        companyName: 'Platform Console',
        roleName: user.role.name,
        isPlatformUser: true,
        companies,
      };
    }

    return {
      email: user.email,
      companyId: user.companyId,
      companyName: user.company?.name || '',
      roleName: user.role?.name || '',
      isPlatformUser: false,
      companies: [],
    };
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: String(email || '').trim().toLowerCase() },
      include: {
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
      },
    });

    if (!user || user.deletedAt) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.isActive) {
      throw new UnauthorizedException(
        'Your account is inactive. Please contact your administrator.',
      );
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const permissions = user.role.permissions.map(
      (rolePermission) => rolePermission.permission.key,
    );

    const payload = {
      sub: user.id,
      email: user.email,
      companyId: user.companyId,
      roleId: user.roleId,
      roleName: user.role.name,
      permissions,
    };

    const accessToken = await this.jwtService.signAsync(payload);

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
      include: {
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
      },
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
      include: {
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
      },
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
      include: {
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
      },
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
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      companyId: user.companyId,
      companyName: user.company.name,
      roleId: user.roleId,
      roleName: user.role.name,
      permissions,
      isActive: user.isActive,
      mustChangePassword: user.mustChangePassword,
    };
  }
}
