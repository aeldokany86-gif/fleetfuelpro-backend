import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ResetUserPasswordDto } from './dto/reset-user-password.dto';

import * as bcrypt from 'bcryptjs';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  private isPlatformUser(roleName: string) {
    const normalizedRole = String(roleName || '')
      .trim()
      .toLowerCase();

    return (
      normalizedRole === 'platform user' ||
      normalizedRole === 'platformuser' ||
      normalizedRole === 'platform admin' ||
      normalizedRole === 'platformadmin'
    );
  }

  private getScopedCompanyId(
    requestedCompanyId: string | undefined,
    actorCompanyId: string,
    actorRoleName: string,
  ) {
    if (this.isPlatformUser(actorRoleName)) {
      return requestedCompanyId || actorCompanyId;
    }

    return actorCompanyId;
  }

  private buildUserScopeWhere(
    id: string,
    actorCompanyId: string,
    actorRoleName: string,
  ) {
    return this.isPlatformUser(actorRoleName)
      ? {
          id,
          deletedAt: null,
        }
      : {
          id,
          companyId: actorCompanyId,
          deletedAt: null,
        };
  }

  private isPlatformConsoleContext(value?: string) {
    const normalizedValue = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '');

    return (
      normalizedValue === '' ||
      normalizedValue === 'platform' ||
      normalizedValue === 'platformconsole'
    );
  }

  async findAll(
    actorCompanyId: string,
    actorRoleName: string,
    selectedCompanyId?: string,
  ) {
    console.log('USERS FINDALL ROLE:', actorRoleName);

    const isPlatform = this.isPlatformUser(actorRoleName);

    const where = isPlatform
      ? this.isPlatformConsoleContext(selectedCompanyId)
        ? {
            deletedAt: null,
          }
        : {
            companyId: selectedCompanyId,
            deletedAt: null,
          }
      : {
          companyId: actorCompanyId,
          deletedAt: null,
        };

    return this.prisma.user.findMany({
      where,
      include: {
        company: true,
        role: true,
      },
      orderBy: {
        fullName: 'asc',
      },
    });
  }

  async create(
    createUserDto: CreateUserDto,
    actorCompanyId: string,
    actorRoleName: string,
    actorUserId?: string,
  ) {
    const targetCompanyId = this.getScopedCompanyId(
      createUserDto.companyId,
      actorCompanyId,
      actorRoleName,
    );

    if (!targetCompanyId) {
      throw new BadRequestException('Company is required');
    }

    const company = await this.prisma.company.findFirst({
      where: {
        id: targetCompanyId,
        deletedAt: null,
        isActive: true,
      },
    });

    if (!company) {
      throw new BadRequestException('Selected company is not valid or inactive');
    }

    const existingUser = await this.prisma.user.findFirst({
      where: {
        email: createUserDto.email,
        deletedAt: null,
      },
    });

    if (existingUser) {
      throw new BadRequestException('Email already exists');
    }

    const selectedRole = await this.prisma.role.findFirst({
      where: {
        id: createUserDto.roleId,
      },
    });

    if (!selectedRole) {
      throw new BadRequestException('Selected role is not valid');
    }

    const roleBelongsToCompany =
      selectedRole.companyId === null ||
      selectedRole.companyId === targetCompanyId;

    if (!roleBelongsToCompany) {
      throw new BadRequestException(
        'Selected role does not belong to the selected company',
      );
    }

    const passwordHash = await bcrypt.hash(
      createUserDto.password,
      10,
    );

    return this.prisma.user.create({
      data: {
        fullName: createUserDto.fullName,
        email: createUserDto.email,
        phone: createUserDto.phone,
        passwordHash,
        roleId: createUserDto.roleId,
        companyId: targetCompanyId,
        createdById: actorUserId || null,
        isActive: true,
        mustChangePassword: true,
      },

      include: {
        company: true,
        role: true,
      },
    });
  }

  async update(
    id: string,
    updateUserDto: UpdateUserDto,
    actorCompanyId: string,
    actorRoleName: string,
  ) {
    const user = await this.prisma.user.findFirst({
      where: this.buildUserScopeWhere(
        id,
        actorCompanyId,
        actorRoleName,
      ),
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (
      updateUserDto.email &&
      updateUserDto.email !== user.email
    ) {
      const existingUser =
        await this.prisma.user.findFirst({
          where: {
            email: updateUserDto.email,
            deletedAt: null,
            NOT: {
              id,
            },
          },
        });

      if (existingUser) {
        throw new BadRequestException(
          'Email already exists',
        );
      }
    }

    if (updateUserDto.roleId) {
      const selectedRole = await this.prisma.role.findFirst({
        where: {
          id: updateUserDto.roleId,
        },
      });

      if (!selectedRole) {
        throw new BadRequestException('Selected role is not valid');
      }

      const roleBelongsToCompany =
        selectedRole.companyId === null ||
        selectedRole.companyId === user.companyId;

      if (!roleBelongsToCompany) {
        throw new BadRequestException(
          'Selected role does not belong to this user company',
        );
      }
    }

    return this.prisma.user.update({
      where: {
        id,
      },

      data: {
        fullName: updateUserDto.fullName,
        email: updateUserDto.email,
        phone: updateUserDto.phone,
        roleId: updateUserDto.roleId,
      },

      include: {
        company: true,
        role: true,
      },
    });
  }

  async updateStatus(
    id: string,
    isActive: boolean,
    actorCompanyId: string,
    actorRoleName: string,
  ) {
    const user = await this.prisma.user.findFirst({
      where: this.buildUserScopeWhere(
        id,
        actorCompanyId,
        actorRoleName,
      ),
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.prisma.user.update({
      where: {
        id,
      },

      data: {
        isActive,
      },

      include: {
        company: true,
        role: true,
      },
    });
  }

  async resetPassword(
    id: string,
    dto: ResetUserPasswordDto,
    actorCompanyId: string,
    actorRoleName: string,
  ) {
    const user = await this.prisma.user.findFirst({
      where: this.buildUserScopeWhere(
        id,
        actorCompanyId,
        actorRoleName,
      ),
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const temporaryPassword =
      dto.temporaryPassword ||
      `FFP@${Math.floor(
        100000 + Math.random() * 900000,
      )}`;

    const hashedPassword = await bcrypt.hash(
      temporaryPassword,
      10,
    );

    await this.prisma.user.update({
      where: {
        id,
      },

      data: {
        passwordHash: hashedPassword,
        mustChangePassword: true,
      },
    });

    return {
      success: true,
      temporaryPassword,
      mustChangePassword: true,
    };
  }
}
