require('dotenv/config');

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('🧹 Resetting development data...');

  // امسح أي Users تجريبية واترك Admin الأساسي
  await prisma.user.deleteMany({
    where: {
      email: {
        not: 'admin@fleetfuelpro.com',
      },
    },
  });

  console.log('✅ Test users deleted');

  console.log('✅ Development reset completed safely');
  console.log('ℹ️ Company, Roles, Permissions, and Admin user were kept');
}

main()
  .catch((error) => {
    console.error('❌ Reset failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });