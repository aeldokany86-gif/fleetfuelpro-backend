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

  private normalizeRoleName(roleName: string) {
    return String(roleName || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '');
  }

  private normalizeEmployeeId(employeeId?: string) {
    return String(employeeId || '')
      .trim()
      .toUpperCase();
  }

  private normalizeEmail(email?: string) {
    const cleanEmail = String(email || '')
      .trim()
      .toLowerCase();

    return cleanEmail || null;
  }

  private normalizeUsername(username?: string) {
    return String(username || '')
      .trim()
      .toLowerCase();
  }

  private normalizeCompanyCode(value?: string) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private buildUsername(company: any, employeeId: string) {
    const companyCode =
      this.normalizeCompanyCode(company?.code) ||
      this.normalizeCompanyCode(company?.name) ||
      this.normalizeCompanyCode(company?.id);

    const normalizedEmployeeId = String(employeeId || '')
      .trim()
      .toLowerCase();

    if (!companyCode || !normalizedEmployeeId) {
      throw new BadRequestException('Username cannot be generated without company code and employee ID');
    }

    return `${companyCode}.${normalizedEmployeeId}`;
  }

  private isPlatformUser(roleName: string) {
    const normalizedRole = this.normalizeRoleName(roleName);

    return (
      normalizedRole === 'platformuser' ||
      normalizedRole === 'platformadmin'
    );
  }

  private isPlatformRoleName(roleName?: string) {
    const normalizedRole = this.normalizeRoleName(roleName || '');

    return (
      normalizedRole === 'platformuser' ||
      normalizedRole === 'platformadmin'
    );
  }

  private isPlatformConsoleCompany(company?: any) {
    const normalizedId = this.normalizeRoleName(company?.id || '');
    const normalizedCode = this.normalizeRoleName(company?.code || '');
    const normalizedName = this.normalizeRoleName(company?.name || '');

    return (
      normalizedId === 'platform' ||
      normalizedCode === 'platform' ||
      normalizedName === 'platformconsole'
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

  private buildUserInclude() {
    return {
      company: true,
      role: true,
      linkedEmployee: {
        include: {
          project: true,
        },
      },
    };
  }

  private async validateRoleForCompany(roleId: string, company: any) {
    const selectedRole = await this.prisma.role.findFirst({
      where: {
        id: roleId,
      },
    });

    if (!selectedRole) {
      throw new BadRequestException('Selected role is not valid');
    }

    const roleBelongsToCompany =
      selectedRole.companyId === null ||
      selectedRole.companyId === company.id;

    if (!roleBelongsToCompany) {
      throw new BadRequestException(
        'Selected role does not belong to the selected company',
      );
    }

    const selectedRoleIsPlatform = this.isPlatformRoleName(selectedRole.name);
    const targetIsPlatformConsole = this.isPlatformConsoleCompany(company);

    if (selectedRoleIsPlatform && !targetIsPlatformConsole) {
      throw new BadRequestException(
        'Platform roles are only allowed inside Platform Console',
      );
    }

    return selectedRole;
  }

  private async resolveEmployeeForUser({
    companyId,
    employeeId,
    linkedEmployeeId,
    excludeUserId,
  }: {
    companyId: string;
    employeeId?: string;
    linkedEmployeeId?: string;
    excludeUserId?: string;
  }) {
    const normalizedEmployeeId = this.normalizeEmployeeId(employeeId);

    if (!normalizedEmployeeId && !linkedEmployeeId) {
      throw new BadRequestException('Employee ID is required');
    }

    const employee = await this.prisma.employee.findFirst({
      where: {
        companyId,
        deletedAt: null,
        ...(linkedEmployeeId
          ? { id: linkedEmployeeId }
          : { employeeId: normalizedEmployeeId }),
      },
      include: {
        project: true,
        linkedUser: true,
      },
    });

    if (!employee) {
      throw new BadRequestException(
        'Employee must exist in Team before creating a user',
      );
    }

    if (employee.linkedUserId && employee.linkedUserId !== excludeUserId) {
      throw new BadRequestException(
        'This employee is already linked to another user',
      );
    }

    return employee;
  }

  async findAll(
    actorCompanyId: string,
    actorRoleName: string,
    selectedCompanyId?: string,
  ) {
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
      include: this.buildUserInclude(),
      orderBy: {
        username: 'asc',
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

    const selectedRole = await this.validateRoleForCompany(
      createUserDto.roleId,
      company,
    );

    const employee = await this.resolveEmployeeForUser({
      companyId: targetCompanyId,
      employeeId: createUserDto.employeeId,
      linkedEmployeeId: createUserDto.linkedEmployeeId,
    });

    const email = this.normalizeEmail(createUserDto.email || employee.email || undefined);

    if (this.isPlatformRoleName(selectedRole.name) && !email) {
      throw new BadRequestException('Email is required for Platform users');
    }

    if (email) {
      const existingUser = await this.prisma.user.findFirst({
        where: {
          email,
          deletedAt: null,
        },
      });

      if (existingUser) {
        throw new BadRequestException('Email already exists');
      }
    }

    const username = this.buildUsername(company, employee.employeeId);

    const existingUsernameUser = await this.prisma.user.findFirst({
      where: {
        username,
        deletedAt: null,
      },
    });

    if (existingUsernameUser) {
      throw new BadRequestException('Username already exists');
    }

    const existingEmployeeUser = await this.prisma.user.findFirst({
      where: {
        companyId: targetCompanyId,
        employeeId: employee.employeeId,
        deletedAt: null,
      },
    });

    if (existingEmployeeUser) {
      throw new BadRequestException('Employee ID is already linked to another user');
    }

    const passwordHash = await bcrypt.hash(
      createUserDto.password,
      10,
    );

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          fullName: createUserDto.fullName?.trim() || employee.name,
          employeeId: employee.employeeId,
          username,
          email,
          phone: createUserDto.phone?.trim() || employee.phone || null,
          passwordHash,
          roleId: createUserDto.roleId,
          companyId: targetCompanyId,
          createdById: actorUserId || null,
          isActive: true,
          mustChangePassword: true,
        },
      });

      await tx.employee.update({
        where: {
          id: employee.id,
        },
        data: {
          linkedUserId: user.id,
        },
      });

      return tx.user.findUnique({
        where: {
          id: user.id,
        },
        include: this.buildUserInclude(),
      });
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
      include: {
        company: true,
        linkedEmployee: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    let nextEmployee: any = null;

    if (
      updateUserDto.employeeId !== undefined ||
      updateUserDto.linkedEmployeeId !== undefined
    ) {
      nextEmployee = await this.resolveEmployeeForUser({
        companyId: user.companyId,
        employeeId: updateUserDto.employeeId || undefined,
        linkedEmployeeId: updateUserDto.linkedEmployeeId || undefined,
        excludeUserId: id,
      });
    }

    const nextEmail =
      updateUserDto.email !== undefined
        ? this.normalizeEmail(updateUserDto.email)
        : undefined;

    if (nextEmail && nextEmail !== user.email) {
      const existingUser = await this.prisma.user.findFirst({
        where: {
          email: nextEmail,
          deletedAt: null,
          NOT: {
            id,
          },
        },
      });

      if (existingUser) {
        throw new BadRequestException('Email already exists');
      }
    }

    let selectedRole: any = null;

    if (updateUserDto.roleId) {
      const company = await this.prisma.company.findFirst({
        where: {
          id: user.companyId,
          deletedAt: null,
        },
      });

      if (!company) {
        throw new BadRequestException('User company is not valid');
      }

      selectedRole = await this.validateRoleForCompany(
        updateUserDto.roleId,
        company,
      );
    }

    if (selectedRole && this.isPlatformRoleName(selectedRole.name)) {
      const effectiveEmail = nextEmail !== undefined ? nextEmail : user.email;

      if (!effectiveEmail) {
        throw new BadRequestException('Email is required for Platform users');
      }
    }

    const nextUsername = nextEmployee
      ? this.buildUsername(user.company, nextEmployee.employeeId)
      : undefined;

    if (nextUsername && nextUsername !== user.username) {
      const existingUsernameUser = await this.prisma.user.findFirst({
        where: {
          username: nextUsername,
          deletedAt: null,
          NOT: {
            id,
          },
        },
      });

      if (existingUsernameUser) {
        throw new BadRequestException('Username already exists');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      if (nextEmployee && user.linkedEmployee?.id !== nextEmployee.id) {
        if (user.linkedEmployee?.id) {
          await tx.employee.update({
            where: {
              id: user.linkedEmployee.id,
            },
            data: {
              linkedUserId: null,
            },
          });
        }

        await tx.employee.update({
          where: {
            id: nextEmployee.id,
          },
          data: {
            linkedUserId: id,
          },
        });
      }

      await tx.user.update({
        where: {
          id,
        },
        data: {
          ...(updateUserDto.fullName !== undefined
            ? { fullName: updateUserDto.fullName?.trim() || nextEmployee?.name || user.fullName }
            : {}),
          ...(nextEmployee
            ? {
                employeeId: nextEmployee.employeeId,
                username: nextUsername,
              }
            : {}),
          ...(nextEmail !== undefined
            ? { email: nextEmail }
            : {}),
          ...(updateUserDto.phone !== undefined
            ? { phone: updateUserDto.phone?.trim() || nextEmployee?.phone || null }
            : {}),
          ...(updateUserDto.roleId !== undefined
            ? { roleId: updateUserDto.roleId }
            : {}),
        },
      });

      return tx.user.findUnique({
        where: {
          id,
        },
        include: this.buildUserInclude(),
      });
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

      include: this.buildUserInclude(),
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
