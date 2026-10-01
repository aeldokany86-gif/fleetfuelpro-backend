import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { XirgoSensorDefinitionSeeder } from './xirgo-sensor-definition.seeder';

function getDirectUrl(): string {
  const directUrl = process.env.DIRECT_URL;

  if (!directUrl) {
    throw new Error('DIRECT_URL environment variable is required for this maintenance script.');
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
    const seeder = new XirgoSensorDefinitionSeeder(
      prisma.telemetrySensorDefinition,
    );

    const preview = await seeder.preview();

    console.log('');
    console.log('Xirgo Sensor Definition Preview');
    console.log('================================');

    for (const item of preview) {
      console.log(
        `${item.action.padEnd(6)}  ${item.vendorSensorId.padEnd(6)}  ${item.parameterCode}`,
      );
    }

    const createCount = preview.filter((x) => x.action === 'CREATE').length;
    const updateCount = preview.filter((x) => x.action === 'UPDATE').length;

    console.log('================================');
    console.log(`CREATE: ${createCount}`);
    console.log(`UPDATE: ${updateCount}`);
    console.log(`TOTAL : ${preview.length}`);
    console.log('');
    console.log('PREVIEW ONLY — no database records were changed.');
    console.log('Connection: DIRECT_URL');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Xirgo sensor definition preview failed.');
  console.error(error);
  process.exit(1);
});
