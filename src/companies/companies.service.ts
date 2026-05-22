import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';

const DEFAULT_COMPANY_ROLES = [
  ['Top Management', 'Dashboards, KPIs, reports, audit logs, export reports'],
  ['Admin', 'Full company access inside company only'],
  ['Manager', 'Project manager access with approvals'],
  ['Supervisor', 'Operations page only within project scope'],
  ['Officer', 'Operational officer with limited management access'],
  ['Operator', 'Direct refuel only'],
] as const;

const DEFAULT_PERMISSIONS = [
  ['companies.read', 'View companies'],
  ['companies.manage', 'Manage companies'],
  ['subscriptions.manage', 'Manage subscriptions'],

  ['users.read', 'View users'],
  ['users.create', 'Create users'],
  ['users.update', 'Update users'],
  ['users.status.change', 'Change user status'],

  ['projects.read', 'View projects'],
  ['projects.manage', 'Manage projects'],

  ['assets.read', 'View assets'],
  ['assets.manage', 'Manage assets'],

  ['stations.read', 'View stations'],
  ['stations.manage', 'Manage stations'],

  ['team.read', 'View team'],
  ['team.manage', 'Manage team'],

  ['operations.read', 'View operations'],
  ['operations.create', 'Create operations'],
  ['operations.correct', 'Correct operations'],

  ['operations.direct_refuel.create', 'Create direct refuel'],
  ['operations.internal_transfer.create', 'Create internal transfer'],
  ['operations.external_supply.create', 'Create external supply'],
  ['operations.external_supply.approve', 'Approve external supply'],

  ['operations.external_transfer.view', 'View external transfer'],
  ['operations.external_transfer.create', 'Create external transfer'],
  ['operations.external_transfer.approve_source', 'Approve source project transfer'],
  ['operations.external_transfer.approve_destination', 'Approve destination project transfer'],

  ['approvals.read', 'View approvals'],
  ['approvals.manage', 'Manage approvals'],

  ['reports.read', 'View reports'],
  ['reports.export', 'Export reports'],

  ['audit_logs.read', 'View audit logs'],

  ['settings.manage', 'Manage company settings'],
] as const;

const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  'Top Management': [
    'projects.read',
    'assets.read',
    'stations.read',
    'team.read',
    'operations.read',
    'reports.read',
    'reports.export',
    'audit_logs.read',
  ],

  Admin: [
    'users.read',
    'users.create',
    'users.update',
    'users.status.change',

    'projects.read',
    'projects.manage',

    'assets.read',
    'assets.manage',

    'stations.read',
    'stations.manage',

    'team.read',
    'team.manage',

    'operations.read',
    'operations.create',
    'operations.correct',

    'operations.direct_refuel.create',
    'operations.internal_transfer.create',

    'operations.external_supply.create',
    'operations.external_supply.approve',

    'operations.external_transfer.view',
    'operations.external_transfer.create',
    'operations.external_transfer.approve_source',
    'operations.external_transfer.approve_destination',

    'approvals.read',
    'approvals.manage',

    'reports.read',
    'reports.export',

    'audit_logs.read',

    'settings.manage',
  ],

  Manager: [
    'users.read',
    'projects.read',
    'assets.read',
    'stations.read',
    'team.read',
    'operations.read',
    'operations.create',
    'operations.correct',
    'operations.direct_refuel.create',
    'operations.internal_transfer.create',
    'operations.external_supply.create',
    'operations.external_supply.approve',
    'operations.external_transfer.view',
    'operations.external_transfer.create',
    'operations.external_transfer.approve_source',
    'operations.external_transfer.approve_destination',
    'approvals.read',
    'approvals.manage',
    'reports.read',
    'reports.export',
    'audit_logs.read',
  ],

  Supervisor: [
    'operations.read',
    'operations.create',
    'operations.correct',
    'operations.direct_refuel.create',
    'operations.internal_transfer.create',
    'operations.external_supply.create',
  ],

  Officer: [
    'projects.read',
    'projects.manage',
    'assets.read',
    'assets.manage',
    'stations.read',
    'stations.manage',
    'team.read',
    'team.manage',
    'operations.read',
    'operations.external_transfer.view',
    'operations.external_transfer.create',
    'reports.read',
  ],

  Operator: [
    'operations.read',
    'operations.create',
    'operations.direct_refuel.create',
  ],
};

@Injectable()
export class CompaniesService {
  constructor(private prisma: PrismaService) {}

  private async ensureDefaultRolesAndPermissionsForCompany(companyId: string) {
    const permissions: Record<string, { id: string }> = {};

    for (const [key, name] of DEFAULT_PERMISSIONS) {
      const permission = await this.prisma.permission.upsert({
        where: { key },
        update: { name },
        create: {
          key,
          name,
        },
      });

      permissions[key] = permission;
    }

    const roles: Record<string, { id: string }> = {};

    for (const [name, description] of DEFAULT_COMPANY_ROLES) {
      const role = await this.prisma.role.upsert({
        where: {
          companyId_name: {
            companyId,
            name,
          },
        },
        update: { description },
        create: {
          companyId,
          name,
          description,
          isSystemRole: true,
        },
      });

      roles[name] = role;
    }

    for (const [roleName, permissionKeys] of Object.entries(
      DEFAULT_ROLE_PERMISSIONS,
    )) {
      const role = roles[roleName];

      if (!role) {
        throw new BadRequestException(`Default role not found: ${roleName}`);
      }

      const allowedPermissionIds = permissionKeys
        .map((key) => permissions[key]?.id)
        .filter(Boolean);

      await this.prisma.rolePermission.deleteMany({
        where: {
          roleId: role.id,
          permissionId: {
            notIn: allowedPermissionIds,
          },
        },
      });

      for (const permissionKey of permissionKeys) {
        const permission = permissions[permissionKey];

        if (!permission) {
          throw new BadRequestException(
            `Default permission not found: ${permissionKey}`,
          );
        }

        await this.prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: role.id,
              permissionId: permission.id,
            },
          },
          update: {},
          create: {
            roleId: role.id,
            permissionId: permission.id,
          },
        });
      }
    }
  }

  async findPublicCompanies() {
    return this.prisma.company.findMany({
      where: {
        deletedAt: null,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        code: true,
        country: true,
        currency: true,
        timezone: true,
        language: true,
        isActive: true,
      },
      orderBy: {
        name: 'asc',
      },
    });
  }

  async findAll() {
    return this.prisma.company.findMany({
      where: {
        deletedAt: null,
      },
      orderBy: {
        name: 'asc',
      },
    });
  }

  async create(dto: CreateCompanyDto) {
    const existingCompany = await this.prisma.company.findFirst({
      where: {
        code: dto.code,
        deletedAt: null,
      },
    });

    if (existingCompany) {
      throw new BadRequestException('Company code already exists');
    }

    const company = await this.prisma.company.create({
      data: {
        name: dto.name,
        code: dto.code,
        country: dto.country || '',
        currency: dto.currency || 'SAR',
        timezone: dto.timezone || 'Asia/Riyadh',
        language: dto.language || 'EN-AR',
        isActive: true,
      },
    });

    await this.ensureDefaultRolesAndPermissionsForCompany(company.id);

    return company;
  }

  async update(id: string, dto: UpdateCompanyDto) {
    const company = await this.prisma.company.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    if (dto.code && dto.code !== company.code) {
      const existingCompany = await this.prisma.company.findFirst({
        where: {
          code: dto.code,
          deletedAt: null,
          NOT: {
            id,
          },
        },
      });

      if (existingCompany) {
        throw new BadRequestException('Company code already exists');
      }
    }

    return this.prisma.company.update({
      where: {
        id,
      },
      data: {
        name: dto.name,
        code: dto.code,
        country: dto.country,
        currency: dto.currency,
        timezone: dto.timezone,
        language: dto.language,
      },
    });
  }

  async updateStatus(id: string, isActive: boolean) {
    const company = await this.prisma.company.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    return this.prisma.company.update({
      where: {
        id,
      },
      data: {
        isActive,
      },
    });
  }
}
