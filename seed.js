require('dotenv/config');

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('Admin@12345', 10);
  const platformPasswordHash = await bcrypt.hash('Platform@123', 10);

  const company = await prisma.company.upsert({
    where: { code: 'FFP' },
    update: {},
    create: {
      name: 'Fleet Fuel PRO',
      code: 'FFP',
      country: 'Saudi Arabia',
      city: 'Jeddah',
      timezone: 'Asia/Riyadh',
      subscriptionPlan: 'trial',
      isActive: true,
    },
  });

  const rolesData = [
    ['Platform User', 'Platform-level access only'],
    ['Top Management', 'Dashboards, KPIs, reports, audit logs, export reports'],
    ['Admin', 'Full company access inside company only'],
    ['Manager', 'Project manager access with approvals'],
    ['Supervisor', 'Operations page only within project scope'],
    ['Officer', 'Operational officer with limited management access'],
    ['Operator', 'Direct refuel only'],
  ];

  const roles = {};

  for (const [name, description] of rolesData) {
    const role = await prisma.role.upsert({
      where: {
        companyId_name: {
          companyId: company.id,
          name,
        },
      },
      update: { description },
      create: {
        companyId: company.id,
        name,
        description,
        isSystemRole: true,
      },
    });

    roles[name] = role;
  }

  const permissionsData = [
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
  ];

  const permissions = {};

  for (const [key, name] of permissionsData) {
    const permission = await prisma.permission.upsert({
      where: { key },
      update: { name },
      create: {
        key,
        name,
      },
    });

    permissions[key] = permission;
  }

  const rolePermissions = {
    'Platform User': [
      'companies.read',
      'companies.manage',
      'subscriptions.manage',
      'users.read',
      'users.create',
      'users.update',
      'users.status.change',
    ],

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

  for (const [roleName, permissionKeys] of Object.entries(rolePermissions)) {
    const role = roles[roleName];

    if (!role) {
      throw new Error(`Role not found: ${roleName}`);
    }

    const allowedPermissionIds = permissionKeys.map((key) => {
      if (!permissions[key]) {
        throw new Error(`Permission not found: ${key}`);
      }

      return permissions[key].id;
    });

    // Important: remove old permissions that are no longer allowed for this role.
    // This prevents Admin from keeping old platform permissions after reseeding.
    await prisma.rolePermission.deleteMany({
      where: {
        roleId: role.id,
        permissionId: {
          notIn: allowedPermissionIds,
        },
      },
    });

    for (const permissionKey of permissionKeys) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permissions[permissionKey].id,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: permissions[permissionKey].id,
        },
      });
    }
  }

  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@fleetfuelpro.com' },
    update: {
      passwordHash,
      roleId: roles.Admin.id,
    },
    create: {
      companyId: company.id,
      roleId: roles.Admin.id,
      fullName: 'Amr Eldokany',
      email: 'admin@fleetfuelpro.com',
      phone: '+966000000000',
      passwordHash,
      isActive: true,
      mustChangePassword: false,
    },
  });

  const platformUser = await prisma.user.upsert({
    where: { email: 'platform@fleetfuelpro.com' },
    update: {
      passwordHash: platformPasswordHash,
      roleId: roles['Platform User'].id,
      companyId: company.id,
      isActive: true,
      mustChangePassword: false,
    },
    create: {
      companyId: company.id,
      roleId: roles['Platform User'].id,
      fullName: 'Platform User',
      email: 'platform@fleetfuelpro.com',
      phone: '+966500000999',
      passwordHash: platformPasswordHash,
      isActive: true,
      mustChangePassword: false,
    },
  });

  console.log('✅ Seed completed successfully');
  console.log('Admin email:', adminUser.email);
  console.log('Admin password: Admin@12345');
  console.log('Platform email:', platformUser.email);
  console.log('Platform password: Platform@123');
  console.log('Admin platform permissions removed: companies.read, companies.manage, subscriptions.manage');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
