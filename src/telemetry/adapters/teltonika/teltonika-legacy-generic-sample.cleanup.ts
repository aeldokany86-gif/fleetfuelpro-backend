import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

function getDirectUrl(): string {
  const directUrl = process.env.DIRECT_URL;

  if (!directUrl) {
    throw new Error(
      'DIRECT_URL environment variable is required for this maintenance script.',
    );
  }

  return directUrl;
}

function requiredArg(name: string): string {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  const value = arg?.slice(prefix.length).trim();

  if (!value) {
    throw new Error(`Missing required argument: --${name}=...`);
  }

  return value;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const deviceId = requiredArg('deviceId');
  const apply = hasFlag('apply');

  // This exact timestamp belongs to the generic Teltonika Codec 8 Extended
  // documentation sample used during early QA. The FMC650 semantic packet
  // uses a different readingAt, so this filter is intentionally narrow.
  const legacyReadingAt = new Date('2019-06-10T11:36:32.000Z');

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: getDirectUrl(),
      },
    },
  });

  try {
    const device = await prisma.telemetryDevice.findFirst({
      where: {
        id: deviceId,
        deletedAt: null,
      },
      select: {
        id: true,
        vendor: true,
        model: true,
        protocol: true,
        transport: true,
      },
    });

    if (!device) {
      throw new Error('Telemetry device not found.');
    }

    if (device.vendor.trim().toUpperCase() !== 'TELTONIKA') {
      throw new Error('Refusing cleanup because device vendor is not TELTONIKA.');
    }

    const rawMessages = await prisma.telemetryRawMessage.findMany({
      where: {
        deviceId,
        protocolVersion: 'CODEC_8_EXTENDED',
        readingAt: legacyReadingAt,
      },
      select: {
        id: true,
        readingAt: true,
        receivedAt: true,
        parseStatus: true,
        checksumValid: true,
      },
      orderBy: {
        receivedAt: 'asc',
      },
    });

    const rawMessageIds = rawMessages.map((item) => item.id);

    const readings = rawMessageIds.length
      ? await prisma.assetTelemetryReading.findMany({
          where: {
            deviceId,
            rawMessageId: { in: rawMessageIds },
          },
          select: {
            id: true,
            rawMessageId: true,
            vendorSensorId: true,
            parameterCode: true,
            numericValue: true,
            unit: true,
            readingAt: true,
            receivedAt: true,
          },
          orderBy: [
            { receivedAt: 'asc' },
            { parameterCode: 'asc' },
          ],
        })
      : [];

    console.log('');
    console.log('Teltonika Legacy Generic-Sample Cleanup');
    console.log('=======================================');
    console.log(`Device ID       : ${device.id}`);
    console.log(`Vendor          : ${device.vendor}`);
    console.log(`Model           : ${device.model ?? 'N/A'}`);
    console.log(`Protocol        : ${device.protocol ?? 'N/A'}`);
    console.log(`Legacy readingAt: ${legacyReadingAt.toISOString()}`);
    console.log('');
    console.log(`Raw messages found: ${rawMessages.length}`);
    console.log(`Readings found    : ${readings.length}`);
    console.log('');

    if (rawMessages.length) {
      console.log('Raw messages:');
      for (const raw of rawMessages) {
        console.log(
          `  ${raw.id} | receivedAt=${raw.receivedAt.toISOString()} | status=${raw.parseStatus} | checksumValid=${raw.checksumValid}`,
        );
      }
      console.log('');
    }

    if (readings.length) {
      console.log('Readings that will be removed:');
      for (const reading of readings) {
        console.log(
          `  ${reading.parameterCode.padEnd(32)} AVL=${reading.vendorSensorId.padEnd(5)} value=${String(
            reading.numericValue ?? 'null',
          ).padEnd(14)} unit=${reading.unit ?? '-'}`,
        );
      }
      console.log('');
    }

    if (!rawMessages.length) {
      console.log('Nothing to clean. No matching generic sample raw message found.');
      return;
    }

    if (!apply) {
      console.log('PREVIEW ONLY — nothing was deleted.');
      console.log('');
      console.log('Run again with --apply after reviewing the preview.');
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const deletedReadings = await tx.assetTelemetryReading.deleteMany({
        where: {
          deviceId,
          rawMessageId: { in: rawMessageIds },
        },
      });

      const deletedRawMessages = await tx.telemetryRawMessage.deleteMany({
        where: {
          id: { in: rawMessageIds },
          deviceId,
        },
      });

      return {
        deletedReadings: deletedReadings.count,
        deletedRawMessages: deletedRawMessages.count,
      };
    });

    console.log('Cleanup applied successfully.');
    console.log(`Deleted readings    : ${result.deletedReadings}`);
    console.log(`Deleted raw messages: ${result.deletedRawMessages}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Teltonika legacy cleanup failed.');
  console.error(error);
  process.exit(1);
});
