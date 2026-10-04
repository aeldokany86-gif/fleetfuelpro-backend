import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  TelemetryParseStatus,
  TelemetryTransport,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { XirgoDecodedPayload } from './adapters/xirgo/xirgo-iotm.decoder';
import { TelemetryAdapterRegistry } from './adapters/telemetry-adapter.registry';
import {
  XirgoSensorDefinition,
  XirgoSensorMapper,
} from './adapters/xirgo/xirgo-sensor.mapper';
import { TeltonikaCodec8ExtendedPayload } from './adapters/teltonika/teltonika-codec8e.decoder';
import {
  TeltonikaSensorDefinition,
  TeltonikaSensorMapper,
} from './adapters/teltonika/teltonika-sensor.mapper';
import { resolveTeltonikaDeviceProfile } from './adapters/teltonika/teltonika-device-profile';

@Injectable()
export class TelemetryIngestionService {
  private readonly xirgoMapper = new XirgoSensorMapper();
  private readonly teltonikaMapper = new TeltonikaSensorMapper();

  constructor(
    private readonly prisma: PrismaService,
    private readonly telemetryAdapterRegistry: TelemetryAdapterRegistry,
  ) {}

  private required(value: string | undefined, name: string) {
    const v = String(value || '').trim();
    if (!v) throw new BadRequestException(`${name} is required`);
    return v;
  }

  private optional(value: string | null | undefined) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return String(value).trim() || null;
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    const seen = new WeakSet<object>();

    const normalize = (input: unknown): unknown => {
      if (input === null) return null;

      if (
        typeof input === 'string' ||
        typeof input === 'number' ||
        typeof input === 'boolean'
      ) {
        return input;
      }

      if (typeof input === 'bigint') return input.toString();
      if (typeof input === 'undefined') return null;

      // Functions and symbols are never valid JSON values.
      if (typeof input === 'function' || typeof input === 'symbol') {
        return undefined;
      }

      if (input instanceof Date) return input.toISOString();
      if (Buffer.isBuffer(input)) return { hex: input.toString('hex') };

      if (Array.isArray(input)) {
        return input
          .map((item) => normalize(item))
          .filter((item) => item !== undefined);
      }

      if (typeof input === 'object') {
        if (seen.has(input)) return '[Circular]';
        seen.add(input);

        const output: Record<string, unknown> = {};

        for (const [key, item] of Object.entries(
          input as Record<string, unknown>,
        )) {
          const normalized = normalize(item);
          if (normalized !== undefined) output[key] = normalized;
        }

        return output;
      }

      return String(input);
    };

    return normalize(value) as Prisma.InputJsonValue;
  }

  async ingestRaw(body: {
    companyId: string;
    deviceId?: string | null;
    transport: TelemetryTransport;
    topic?: string | null;
    payload: string;
    payloadEncoding?: 'utf8' | 'base64' | 'hex';
    protocolVersion?: string | null;
    checksumValid?: boolean | null;
    readingAt?: string | null;
    metadata?: Prisma.InputJsonValue | null;
  }) {
    const companyId = this.required(body.companyId, 'Company ID');
    const payload = this.required(body.payload, 'Payload');
    const encoding = body.payloadEncoding ?? 'utf8';

    if (!body.transport) {
      throw new BadRequestException('Transport is required');
    }

    const company = await this.prisma.company.findFirst({
      where: { id: companyId, deletedAt: null, isActive: true },
      select: { id: true },
    });

    if (!company) {
      throw new BadRequestException('Company not found or inactive');
    }

    let deviceId: string | null = null;

    if (body.deviceId) {
      const device = await this.prisma.telemetryDevice.findFirst({
        where: { id: body.deviceId, companyId, deletedAt: null },
        select: { id: true },
      });

      if (!device) {
        throw new NotFoundException(
          'Telemetry device not found or does not belong to this company',
        );
      }

      deviceId = device.id;
    }

    const payloadBuffer = Buffer.from(payload, encoding);

    if (!payloadBuffer.length) {
      throw new BadRequestException('Payload is empty');
    }

    let readingAt: Date | null = null;

    if (body.readingAt) {
      readingAt = new Date(body.readingAt);

      if (Number.isNaN(readingAt.getTime())) {
        throw new BadRequestException('Reading time is invalid');
      }
    }

    return this.prisma.telemetryRawMessage.create({
      data: {
        companyId,
        deviceId,
        transport: body.transport,
        topic: this.optional(body.topic),
        payload: payloadBuffer,
        protocolVersion: this.optional(body.protocolVersion),
        parseStatus: TelemetryParseStatus.RECEIVED,
        checksumValid: body.checksumValid ?? null,
        readingAt,
        receivedAt: new Date(),
        ...(body.metadata !== undefined
          ? {
              metadata:
                body.metadata === null
                  ? Prisma.JsonNull
                  : this.toJsonValue(body.metadata),
            }
          : {}),
      },
      select: {
        id: true,
        companyId: true,
        deviceId: true,
        transport: true,
        topic: true,
        protocolVersion: true,
        parseStatus: true,
        checksumValid: true,
        readingAt: true,
        receivedAt: true,
        parseError: true,
        metadata: true,
      },
    });
  }

  async ingestXirgo(body: {
    companyId: string;
    deviceId: string;
    transport: TelemetryTransport;
    topic?: string | null;
    payload: string;
    payloadEncoding?: 'base64' | 'hex';
    metadata?: Prisma.InputJsonValue | null;
    // Internal optimization for trusted callers such as the MQTT subscriber.
    // HTTP callers can omit this and the service will decode the payload itself.
    decodedPayload?: XirgoDecodedPayload;
  }) {
    const companyId = this.required(body.companyId, 'Company ID');
    const deviceId = this.required(body.deviceId, 'Device ID');
    const payload = this.required(body.payload, 'Payload');
    const encoding = body.payloadEncoding ?? 'hex';
    const receivedAt = new Date();

    if (!body.transport) {
      throw new BadRequestException('Transport is required');
    }

    const device = await this.prisma.telemetryDevice.findFirst({
      where: {
        id: deviceId,
        companyId,
        deletedAt: null,
      },
      select: {
        id: true,
        assetId: true,
        vendor: true,
        hardwareId: true,
      },
    });

    if (!device) {
      throw new NotFoundException(
        'Telemetry device not found or does not belong to this company',
      );
    }

    if (device.vendor.trim().toUpperCase() !== 'XIRGO') {
      throw new BadRequestException('Telemetry device is not a Xirgo device');
    }

    if (!device.assetId) {
      throw new BadRequestException(
        'Telemetry device must be assigned to an asset before Xirgo telemetry can be processed',
      );
    }

    const payloadBuffer = Buffer.from(payload.replace(/\s+/g, ''), encoding);

    if (!payloadBuffer.length) {
      throw new BadRequestException('Payload is empty');
    }

    const raw = await this.prisma.telemetryRawMessage.create({
      data: {
        companyId,
        deviceId: device.id,
        transport: body.transport,
        topic: this.optional(body.topic),
        payload: payloadBuffer,
        protocolVersion: 'XG_IOTM_V2',
        parseStatus: TelemetryParseStatus.RECEIVED,
        receivedAt,
        ...(body.metadata !== undefined
          ? {
              metadata:
                body.metadata === null
                  ? Prisma.JsonNull
                  : this.toJsonValue(body.metadata),
            }
          : {}),
      },
      select: {
        id: true,
        receivedAt: true,
      },
    });

    try {
      const decoded =
        body.decodedPayload ?? this.telemetryAdapterRegistry.decodeXirgoIotm(payloadBuffer);

      const telemetryRecords = decoded.records.filter(
        (record) => record.kind === 'TELEMETRY',
      );

      const sensorIds = [
        ...new Set(
          telemetryRecords.flatMap((record) =>
            record.kind === 'TELEMETRY'
              ? record.sensors.map((sensor) => String(sensor.sensorId))
              : [],
          ),
        ),
      ];

      const definitions = sensorIds.length
        ? await this.prisma.telemetrySensorDefinition.findMany({
            where: {
              vendor: 'XIRGO',
              vendorSensorId: { in: sensorIds },
              isActive: true,
              OR: [{ companyId }, { companyId: null }],
            },
          })
        : [];

      const definitionBySensorId = new Map<string, XirgoSensorDefinition>();

      for (const definition of definitions) {
        const key = definition.vendorSensorId;
        const existing = definitionBySensorId.get(key);

        // Company-specific definition wins over the global definition.
        if (!existing || definition.companyId === companyId) {
          definitionBySensorId.set(key, {
            id: definition.id,
            vendorSensorId: definition.vendorSensorId,
            parameterCode: definition.parameterCode,
            displayName: definition.displayName,
            unit: definition.unit,
            multiplier: definition.multiplier,
            offset: definition.offset,
            dataSource: definition.dataSource,
            isActive: definition.isActive,
          });
        }
      }

      const readings: Prisma.AssetTelemetryReadingCreateManyInput[] = [];

      for (const record of telemetryRecords) {
        if (record.kind !== 'TELEMETRY') continue;

        for (const sensor of record.sensors) {
          const mapped = this.xirgoMapper.map(
            sensor,
            definitionBySensorId.get(String(sensor.sensorId)),
          );

          readings.push({
            companyId,
            assetId: device.assetId,
            deviceId: device.id,
            rawMessageId: raw.id,
            sensorDefinitionId: mapped.sensorDefinitionId ?? null,
            vendorSensorId: mapped.vendorSensorId,
            parameterCode: mapped.parameterCode,
            rawValue: this.toJsonValue(mapped.rawValue),
            numericValue: mapped.numericValue,
            textValue: mapped.textValue,
            jsonValue:
              mapped.jsonValue === null
                ? Prisma.JsonNull
                : this.toJsonValue(mapped.jsonValue),
            unit: mapped.unit,
            dataSource: mapped.dataSource,
            readingAt: record.timestamp,
            receivedAt: raw.receivedAt,
          });
        }
      }

      const latestReadingAt =
        telemetryRecords
          .filter((record) => record.kind === 'TELEMETRY')
          .map((record) => record.timestamp)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

      const transactionOperations: Prisma.PrismaPromise<unknown>[] = [];

      if (readings.length) {
        transactionOperations.push(
          this.prisma.assetTelemetryReading.createMany({
            data: readings,
          }),
        );
      }

      // IMPORTANT: Xirgo decoder may expose checksumValid as a callable helper.
      // Prisma scalar fields must receive a primitive value, never a function.
      const checksumValid =
        typeof decoded.checksumValid === 'boolean'
          ? decoded.checksumValid
          : null;

      transactionOperations.push(
        this.prisma.telemetryRawMessage.update({
          where: { id: raw.id },
          data: {
            parseStatus: TelemetryParseStatus.PARSED,
            checksumValid,
            readingAt: latestReadingAt,
            parseError: null,
          },
        }),
        this.prisma.telemetryDevice.update({
          where: { id: device.id },
          data: { lastSeenAt: receivedAt },
        }),
      );

      await this.prisma.$transaction(transactionOperations);

      return {
        rawMessageId: raw.id,
        deviceId: device.id,
        assetId: device.assetId,
        imei: decoded.imei,
        checksumValid,
        telemetryRecordCount: telemetryRecords.length,
        readingCount: readings.length,
        parseStatus: TelemetryParseStatus.PARSED,
        readingAt: latestReadingAt,
        receivedAt,
      };
    } catch (error) {
      console.error('XIRGO ORIGINAL INGEST ERROR:', error);

      const message =
        error instanceof Error ? error.message : 'Unknown Xirgo parse error';

      // TEMPORARY DIAGNOSTIC MODE:
      // Do not update TelemetryRawMessage here. The failure-update query was
      // masking the original ingestion error with a Prisma serde_json error.
      throw new BadRequestException(`Xirgo telemetry parse failed: ${message}`);
    }
  }

  async ingestTeltonikaCodec8Extended(body: {
    companyId: string;
    deviceId: string;
    transport: TelemetryTransport;
    payload: string;
    payloadEncoding?: 'base64' | 'hex';
    metadata?: Prisma.InputJsonValue | null;
    decodedPayload?: TeltonikaCodec8ExtendedPayload;
  }) {
    const companyId = this.required(body.companyId, 'Company ID');
    const deviceId = this.required(body.deviceId, 'Device ID');
    const payload = this.required(body.payload, 'Payload');
    const encoding = body.payloadEncoding ?? 'hex';
    const receivedAt = new Date();

    if (!body.transport) {
      throw new BadRequestException('Transport is required');
    }

    const device = await this.prisma.telemetryDevice.findFirst({
      where: {
        id: deviceId,
        companyId,
        deletedAt: null,
      },
      select: {
        id: true,
        assetId: true,
        vendor: true,
        hardwareId: true,
        model: true,
        protocol: true,
        transport: true,
        company: {
          select: {
            telemetryEnabled: true,
          },
        },
      },
    });

    if (!device) {
      throw new NotFoundException(
        'Telemetry device not found or does not belong to this company',
      );
    }

    if (!device.company.telemetryEnabled) {
      throw new BadRequestException('Telemetry is disabled for this company');
    }

    if (device.vendor.trim().toUpperCase() !== 'TELTONIKA') {
      throw new BadRequestException(
        'Telemetry device is not a Teltonika device',
      );
    }

    if (
      device.protocol &&
      device.protocol.trim().toUpperCase() !== 'CODEC_8_EXTENDED'
    ) {
      throw new BadRequestException(
        'Telemetry device is not configured for Codec 8 Extended',
      );
    }

    if (device.transport && device.transport !== TelemetryTransport.TCP) {
      throw new BadRequestException(
        'Telemetry device is not configured for TCP transport',
      );
    }

    if (!device.assetId) {
      throw new BadRequestException(
        'Telemetry device must be assigned to an asset before Teltonika telemetry can be processed',
      );
    }

    const deviceProfile = resolveTeltonikaDeviceProfile(device.model);

    if (!deviceProfile) {
      throw new BadRequestException(
        `Unsupported Teltonika device profile for model: ${device.model ?? 'UNKNOWN'}`,
      );
    }

    const payloadBuffer = Buffer.from(payload.replace(/\s+/g, ''), encoding);

    if (!payloadBuffer.length) {
      throw new BadRequestException('Payload is empty');
    }

    const raw = await this.prisma.telemetryRawMessage.create({
      data: {
        companyId,
        deviceId: device.id,
        transport: body.transport,
        payload: payloadBuffer,
        protocolVersion: 'CODEC_8_EXTENDED',
        parseStatus: TelemetryParseStatus.RECEIVED,
        receivedAt,
        ...(body.metadata !== undefined
          ? {
              metadata:
                body.metadata === null
                  ? Prisma.JsonNull
                  : this.toJsonValue(body.metadata),
            }
          : {}),
      },
      select: {
        id: true,
        receivedAt: true,
      },
    });

    try {
      const decoded =
        body.decodedPayload ??
        this.telemetryAdapterRegistry.decodeTeltonikaCodec8Extended(
          payloadBuffer,
        );

      if (!decoded.checksumValid) {
        throw new Error(
          `Invalid Teltonika CRC: received ${decoded.crc}, calculated ${decoded.calculatedCrc}`,
        );
      }

      const avlIds = [
        ...new Set(
          decoded.records.flatMap((record) =>
            record.ioElements.map((io) => String(io.avlId)),
          ),
        ),
      ];

      const definitions = avlIds.length
        ? await this.prisma.telemetrySensorDefinition.findMany({
            where: {
              vendor: 'TELTONIKA',
              protocol: 'CODEC_8_EXTENDED',
              vendorSensorId: { in: avlIds },
              isActive: true,
              OR: [{ companyId }, { companyId: null }],
            },
          })
        : [];

      const definitionByAvlId = new Map<string, TeltonikaSensorDefinition>();

      for (const definition of definitions) {
        const metadata =
          definition.metadata &&
          typeof definition.metadata === 'object' &&
          !Array.isArray(definition.metadata)
            ? (definition.metadata as Record<string, unknown>)
            : null;

        if (metadata?.deviceProfile !== deviceProfile) {
          continue;
        }

        const key = definition.vendorSensorId;
        const existing = definitionByAvlId.get(key);

        if (!existing || definition.companyId === companyId) {
          definitionByAvlId.set(key, {
            id: definition.id,
            vendorSensorId: definition.vendorSensorId,
            deviceProfile,
            parameterCode: definition.parameterCode,
            displayName: definition.displayName,
            unit: definition.unit,
            multiplier: definition.multiplier,
            offset: definition.offset,
            dataSource: definition.dataSource,
            signed: metadata?.signed === true,
            isActive: definition.isActive,
          });
        }
      }

      const readings: Prisma.AssetTelemetryReadingCreateManyInput[] = [];

      for (const record of decoded.records) {
        for (const io of record.ioElements) {
          const mapped = this.teltonikaMapper.map(
            io,
            definitionByAvlId.get(String(io.avlId)),
          );

          readings.push({
            companyId,
            assetId: device.assetId,
            deviceId: device.id,
            rawMessageId: raw.id,
            sensorDefinitionId: mapped.sensorDefinitionId ?? null,
            vendorSensorId: mapped.vendorSensorId,
            parameterCode: mapped.parameterCode,
            rawValue: this.toJsonValue(mapped.rawValue),
            numericValue: mapped.numericValue,
            textValue: mapped.textValue,
            jsonValue:
              mapped.jsonValue === null
                ? Prisma.JsonNull
                : this.toJsonValue(mapped.jsonValue),
            unit: mapped.unit,
            dataSource: mapped.dataSource,
            readingAt: record.timestamp,
            receivedAt: raw.receivedAt,
            metadata: this.toJsonValue({
              deviceProfile,
              teltonikaPriority: record.priority,
              eventIoId: record.eventIoId,
              gps: record.gps,
            }),
          });
        }
      }

      const latestReadingAt =
        decoded.records
          .map((record) => record.timestamp)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

      const transactionOperations: Prisma.PrismaPromise<unknown>[] = [];

      if (readings.length) {
        transactionOperations.push(
          this.prisma.assetTelemetryReading.createMany({
            data: readings,
          }),
        );
      }

      transactionOperations.push(
        this.prisma.telemetryRawMessage.update({
          where: { id: raw.id },
          data: {
            parseStatus: TelemetryParseStatus.PARSED,
            checksumValid: decoded.checksumValid,
            readingAt: latestReadingAt,
            parseError: null,
          },
        }),
        this.prisma.telemetryDevice.update({
          where: { id: device.id },
          data: { lastSeenAt: receivedAt },
        }),
      );

      await this.prisma.$transaction(transactionOperations);

      return {
        rawMessageId: raw.id,
        deviceId: device.id,
        assetId: device.assetId,
        checksumValid: decoded.checksumValid,
        telemetryRecordCount: decoded.numberOfData1,
        readingCount: readings.length,
        parseStatus: TelemetryParseStatus.PARSED,
        readingAt: latestReadingAt,
        receivedAt,
      };
    } catch (error) {
      console.error('TELTONIKA ORIGINAL INGEST ERROR:', error);

      const message =
        error instanceof Error
          ? error.message
          : 'Unknown Teltonika parse error';

      throw new BadRequestException(
        `Teltonika telemetry parse failed: ${message}`,
      );
    }
  }

}
