import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function normalizeUsernamePart(value: string) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

async function main() {
  console.log('Starting username backfill...');

  const users = await prisma.user.findMany({
    where: {
      OR: [{ username: null }, { username: '' }],
      deletedAt: null,
    },
    include: {
      company: true,
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  console.log(`Users needing username: ${users.length}`);

  let updated = 0;
  let skipped = 0;

  for (const user of users) {
    const companyCode = normalizeUsernamePart(user.company?.code || '');
    const employeeId = normalizeUsernamePart(user.employeeId || '');

    if (!companyCode || !employeeId) {
      skipped += 1;
      console.warn(
        `Skipped user ${user.id}: missing ${!companyCode ? 'company code' : 'employeeId'}`,
      );
      continue;
    }

    const username = `${companyCode}.${employeeId}`;

    const existing = await prisma.user.findFirst({
      where: {
        username,
        NOT: {
          id: user.id,
        },
      },
      select: {
        id: true,
        employeeId: true,
        email: true,
      },
    });

    if (existing) {
      skipped += 1;
      console.warn(
        `Skipped user ${user.id}: username ${username} already used by user ${existing.id}`,
      );
      continue;
    }

    await prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        username,
      },
    });

    updated += 1;
    console.log(`Updated user ${user.id}: ${username}`);
  }

  console.log('Username backfill completed.');
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
}

main()
  .catch((error) => {
    console.error('Username backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
