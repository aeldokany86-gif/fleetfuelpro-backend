import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_COMPANY_ROLES = [
  ['Top Management', 'Dashboards, KPIs, reports, audit logs, export reports'],
  ['Admin', 'Full company access inside company only'],
  ['Manager', 'Project manager access with approvals'],
  ['Supervisor', 'Operations page only within project scope'],
  ['Officer', 'Operational officer with limited management access'],
  ['Operator', 'Direct refuel only'],
] as const;

const PERMISSIONS_DATA = [
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

const ROLE_PERMISSIONS: Record<string, string[]> = {
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
    'stations.read',
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
export class RolesService {
  constructor(private prisma: PrismaService) {}

  private normalizeRoleName(roleName: string) {
    return String(roleName || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '');
  }

  private isPlatformUser(roleName: string) {
    const normalizedRole = this.normalizeRoleName(roleName);
    return normalizedRole === 'platformuser' || normalizedRole === 'platformadmin';
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

  private async ensurePermissions() {
    const permissions: Record<string, { id: string }> = {};

    for (const [key, name] of PERMISSIONS_DATA) {
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

    return permissions;
  }

  private async syncRolePermissions(
    roleId: string,
    permissionKeys: string[],
    permissions: Record<string, { id: string }>,
  ) {
    const allowedPermissionIds = permissionKeys
      .map((key) => permissions[key]?.id)
      .filter(Boolean);

    await this.prisma.rolePermission.deleteMany({
      where: {
        roleId,
        permissionId: {
          notIn: allowedPermissionIds,
        },
      },
    });

    for (const permissionKey of permissionKeys) {
      const permission = permissions[permissionKey];

      if (!permission) {
        throw new BadRequestException(
          `Permission not found: ${permissionKey}`,
        );
      }

      await this.prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId,
          permissionId: permission.id,
        },
      });
    }
  }

  private async ensureGlobalCustomerRoles() {
    const permissions = await this.ensurePermissions();

    for (const [name, description] of DEFAULT_COMPANY_ROLES) {
      let role = await this.prisma.role.findFirst({
        where: {
          companyId: null,
          name,
        },
        orderBy: {
          createdAt: 'asc',
        },
      });

      if (!role) {
        role = await this.prisma.role.create({
          data: {
            companyId: null,
            name,
            description,
            isSystemRole: true,
          },
        });
      } else {
        role = await this.prisma.role.update({
          where: { id: role.id },
          data: {
            description,
            isSystemRole: true,
          },
        });
      }

      await this.syncRolePermissions(
        role.id,
        ROLE_PERMISSIONS[name] || [],
        permissions,
      );
    }
  }

  private async ensurePlatformRole(company: any) {
    if (!this.isPlatformConsoleCompany(company)) {
      throw new BadRequestException('Platform Console company is required');
    }

    let role = await this.prisma.role.findFirst({
      where: {
        companyId: company.id,
        name: {
          equals: 'Platform User',
          mode: 'insensitive',
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    if (!role) {
      role = await this.prisma.role.create({
        data: {
          companyId: company.id,
          name: 'Platform User',
          description: 'Platform-level access only',
          isSystemRole: true,
        },
      });
    }

    return role;
  }

  async findAll(
    requesterCompanyId: string,
    requesterRoleName: string,
    requestedCompanyId?: string,
  ) {
    const targetCompanyId = this.isPlatformUser(requesterRoleName)
      ? requestedCompanyId || requesterCompanyId
      : requesterCompanyId;

    if (!targetCompanyId) {
      throw new BadRequestException('Company ID is required');
    }

    const targetCompany = await this.prisma.company.findFirst({
      where: {
        id: targetCompanyId,
        deletedAt: null,
        isActive: true,
      },
    });

    if (!targetCompany) {
      throw new NotFoundException('Company not found');
    }

    if (this.isPlatformConsoleCompany(targetCompany)) {
      const platformRole = await this.ensurePlatformRole(targetCompany);

      return this.prisma.role.findMany({
        where: {
          id: platformRole.id,
        },
        orderBy: {
          name: 'asc',
        },
      });
    }

    await this.ensureGlobalCustomerRoles();

    return this.prisma.role.findMany({
      where: {
        companyId: null,
        name: {
          in: DEFAULT_COMPANY_ROLES.map(([name]) => name),
        },
      },
      orderBy: {
        name: 'asc',
      },
    });
  }
}
