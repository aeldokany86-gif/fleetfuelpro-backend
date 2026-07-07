require('dotenv').config({path: '.env'});
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const officer = await prisma.role.findFirst({ where: { name: 'Officer' } });
  if (!officer) { console.log('Officer role not found'); return; }
  const perms = await prisma.permission.findMany({ where: { key: { in: ['assets.manage', 'stations.manage'] } } });
  const permIds = perms.map(p => p.id);
  const result = await prisma.rolePermission.deleteMany({ where: { roleId: officer.id, permissionId: { in: permIds } } });
  console.log('Deleted:', result.count, 'permissions');
  await prisma['']();
}
main();
