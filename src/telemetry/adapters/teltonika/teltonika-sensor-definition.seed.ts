import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { TeltonikaSensorDefinitionSeeder } from './teltonika-sensor-definition.seeder';

function getDirectUrl(): string {
  const directUrl = process.env.DIRECT_URL;

  if (!directUrl) {
    throw new Error(
      'DIRECT_URL environment variable is required for this maintenance script.',
    );
  }

  return directUrl;
}

async function main() {
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: getDirectUrl(),
      },
    },
  });

  try {
    const seeder = new TeltonikaSensorDefinitionSeeder(
      prisma.telemetrySensorDefinition,
    );

    console.log('');
    console.log('Teltonika FMC650 Sensor Definition Seed');
    console.log('=======================================');
    console.log('Connection: DIRECT_URL');

    const result = await seeder.seed();

    console.log('=======================================');
    console.log(`CREATED: ${result.created}`);
    console.log(`UPDATED: ${result.updated}`);
    console.log(`TOTAL  : ${result.total}`);
    console.log('=======================================');
    console.log('Teltonika sensor definitions seeded successfully.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Teltonika sensor definition seed failed.');
  console.error(error);
  process.exit(1);
});
