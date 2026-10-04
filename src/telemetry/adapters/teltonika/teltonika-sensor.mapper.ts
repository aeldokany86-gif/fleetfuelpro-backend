import { TelemetryDataSource } from '@prisma/client';
import { TeltonikaIoElement } from './teltonika-codec8e.decoder';

export type TeltonikaSensorDefinition = {
  id?: string;
  vendorSensorId: string;
  parameterCode: string;
  deviceProfile?: string | null;
  displayName?: string | null;
  unit?: string | null;
  multiplier?: number | null;
  offset?: number | null;
  dataSource: TelemetryDataSource;
  signed?: boolean;
  isActive?: boolean;
};

export type TeltonikaMappedSensor = {
  sensorDefinitionId?: string;
  vendorSensorId: string;
  parameterCode: string;
  displayName?: string | null;
  rawValue: number | bigint | { hex: string };
  numericValue: number | null;
  textValue: string | null;
  jsonValue: unknown | null;
  unit: string | null;
  dataSource: TelemetryDataSource;
};

export class TeltonikaSensorMapper {
  map(
    io: TeltonikaIoElement,
    definition: TeltonikaSensorDefinition | null | undefined,
  ): TeltonikaMappedSensor {
    if (!definition || definition.isActive === false) {
      return this.mapUnknown(io);
    }

    const multiplier = definition.multiplier ?? 1;
    const offset = definition.offset ?? 0;
    const normalizedRaw = this.normalizeRawValue(io, definition.signed === true);

    if (typeof normalizedRaw === 'number') {
      return {
        sensorDefinitionId: definition.id,
        vendorSensorId: String(io.avlId),
        parameterCode: definition.parameterCode,
        displayName: definition.displayName,
        rawValue: normalizedRaw,
        numericValue: normalizedRaw * multiplier + offset,
        textValue: null,
        jsonValue: null,
        unit: definition.unit ?? null,
        dataSource: definition.dataSource,
      };
    }

    if (typeof normalizedRaw === 'bigint') {
      const numeric = Number(normalizedRaw);

      return {
        sensorDefinitionId: definition.id,
        vendorSensorId: String(io.avlId),
        parameterCode: definition.parameterCode,
        displayName: definition.displayName,
        rawValue: normalizedRaw,
        numericValue: Number.isSafeInteger(numeric)
          ? numeric * multiplier + offset
          : null,
        textValue: normalizedRaw.toString(),
        jsonValue: null,
        unit: definition.unit ?? null,
        dataSource: definition.dataSource,
      };
    }

    return {
      sensorDefinitionId: definition.id,
      vendorSensorId: String(io.avlId),
      parameterCode: definition.parameterCode,
      displayName: definition.displayName,
      rawValue: { hex: normalizedRaw.toString('hex') },
      numericValue: null,
      textValue: null,
      jsonValue: { hex: normalizedRaw.toString('hex') },
      unit: definition.unit ?? null,
      dataSource: definition.dataSource,
    };
  }

  private normalizeRawValue(
    io: TeltonikaIoElement,
    signed: boolean,
  ): number | bigint | Buffer {
    if (!signed || Buffer.isBuffer(io.value)) {
      return io.value;
    }

    if (typeof io.value === 'number') {
      const bits = io.length * 8;
      const signBit = 2 ** (bits - 1);
      const fullRange = 2 ** bits;

      return io.value >= signBit ? io.value - fullRange : io.value;
    }

    const bits = BigInt(io.length * 8);
    const signBit = 1n << (bits - 1n);
    const fullRange = 1n << bits;

    return io.value >= signBit ? io.value - fullRange : io.value;
  }

  private mapUnknown(io: TeltonikaIoElement): TeltonikaMappedSensor {
    const rawValue = Buffer.isBuffer(io.value)
      ? { hex: io.value.toString('hex') }
      : io.value;

    return {
      vendorSensorId: String(io.avlId),
      parameterCode: `TELTONIKA_AVL_${io.avlId}`,
      displayName: null,
      rawValue,
      numericValue:
        typeof io.value === 'number'
          ? io.value
          : typeof io.value === 'bigint' && Number.isSafeInteger(Number(io.value))
            ? Number(io.value)
            : null,
      textValue:
        typeof io.value === 'bigint' ? io.value.toString() : null,
      jsonValue:
        Buffer.isBuffer(io.value) ? { hex: io.value.toString('hex') } : null,
      unit: null,
      dataSource: TelemetryDataSource.UNKNOWN,
    };
  }
}
