import { TelemetryDataSource } from '@prisma/client';
import { XirgoDecodedSensor } from './xirgo-iotm.decoder';

export type XirgoSensorDefinition = {
  id?: string;
  vendorSensorId: string;
  parameterCode: string;
  displayName?: string | null;
  unit?: string | null;
  multiplier?: number | null;
  offset?: number | null;
  dataSource: TelemetryDataSource;
  isActive?: boolean;
};

export type XirgoMappedSensor = {
  sensorDefinitionId?: string;
  vendorSensorId: string;
  parameterCode: string;
  displayName?: string | null;
  rawValue: XirgoDecodedSensor['value'];
  numericValue: number | null;
  textValue: string | null;
  jsonValue: unknown | null;
  unit: string | null;
  dataSource: TelemetryDataSource;
};

export class XirgoSensorMapper {
  map(
    sensor: XirgoDecodedSensor,
    definition: XirgoSensorDefinition | null | undefined,
  ): XirgoMappedSensor {
    if (!definition || definition.isActive === false) {
      return this.mapUnknown(sensor);
    }

    const multiplier = definition.multiplier ?? 1;
    const offset = definition.offset ?? 0;

    if (typeof sensor.value === 'number') {
      return {
        sensorDefinitionId: definition.id,
        vendorSensorId: String(sensor.sensorId),
        parameterCode: definition.parameterCode,
        displayName: definition.displayName,
        rawValue: sensor.value,
        numericValue: sensor.value * multiplier + offset,
        textValue: null,
        jsonValue: null,
        unit: definition.unit ?? null,
        dataSource: definition.dataSource,
      };
    }

    if (typeof sensor.value === 'bigint') {
      const numeric = Number(sensor.value);
      return {
        sensorDefinitionId: definition.id,
        vendorSensorId: String(sensor.sensorId),
        parameterCode: definition.parameterCode,
        displayName: definition.displayName,
        rawValue: sensor.value,
        numericValue: Number.isSafeInteger(numeric)
          ? numeric * multiplier + offset
          : null,
        textValue: sensor.value.toString(),
        jsonValue: null,
        unit: definition.unit ?? null,
        dataSource: definition.dataSource,
      };
    }

    if (typeof sensor.value === 'boolean') {
      return {
        sensorDefinitionId: definition.id,
        vendorSensorId: String(sensor.sensorId),
        parameterCode: definition.parameterCode,
        displayName: definition.displayName,
        rawValue: sensor.value,
        numericValue: sensor.value ? 1 : 0,
        textValue: null,
        jsonValue: null,
        unit: definition.unit ?? null,
        dataSource: definition.dataSource,
      };
    }

    if (typeof sensor.value === 'string') {
      return {
        sensorDefinitionId: definition.id,
        vendorSensorId: String(sensor.sensorId),
        parameterCode: definition.parameterCode,
        displayName: definition.displayName,
        rawValue: sensor.value,
        numericValue: null,
        textValue: sensor.value,
        jsonValue: null,
        unit: definition.unit ?? null,
        dataSource: definition.dataSource,
      };
    }

    if (Buffer.isBuffer(sensor.value)) {
      return {
        sensorDefinitionId: definition.id,
        vendorSensorId: String(sensor.sensorId),
        parameterCode: definition.parameterCode,
        displayName: definition.displayName,
        rawValue: sensor.value,
        numericValue: null,
        textValue: null,
        jsonValue: { hex: sensor.value.toString('hex') },
        unit: definition.unit ?? null,
        dataSource: definition.dataSource,
      };
    }

    if (sensor.value && typeof sensor.value === 'object') {
      return {
        sensorDefinitionId: definition.id,
        vendorSensorId: String(sensor.sensorId),
        parameterCode: definition.parameterCode,
        displayName: definition.displayName,
        rawValue: sensor.value,
        numericValue: null,
        textValue: null,
        jsonValue: sensor.value,
        unit: definition.unit ?? null,
        dataSource: definition.dataSource,
      };
    }

    return {
      sensorDefinitionId: definition.id,
      vendorSensorId: String(sensor.sensorId),
      parameterCode: definition.parameterCode,
      displayName: definition.displayName,
      rawValue: sensor.value,
      numericValue: null,
      textValue: null,
      jsonValue: null,
      unit: definition.unit ?? null,
      dataSource: definition.dataSource,
    };
  }

  private mapUnknown(sensor: XirgoDecodedSensor): XirgoMappedSensor {
    return {
      vendorSensorId: String(sensor.sensorId),
      parameterCode: `XIRGO_SENSOR_${sensor.sensorId}`,
      displayName: null,
      rawValue: sensor.value,
      numericValue:
        typeof sensor.value === 'number'
          ? sensor.value
          : typeof sensor.value === 'boolean'
            ? sensor.value ? 1 : 0
            : null,
      textValue:
        typeof sensor.value === 'string'
          ? sensor.value
          : typeof sensor.value === 'bigint'
            ? sensor.value.toString()
            : null,
      jsonValue:
        Buffer.isBuffer(sensor.value)
          ? { hex: sensor.value.toString('hex') }
          : sensor.value && typeof sensor.value === 'object'
            ? sensor.value
            : null,
      unit: null,
      dataSource: TelemetryDataSource.UNKNOWN,
    };
  }
}
