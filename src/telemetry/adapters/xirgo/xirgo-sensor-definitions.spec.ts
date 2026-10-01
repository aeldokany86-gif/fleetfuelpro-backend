import { TelemetryDataSource } from '@prisma/client';
import {
  getXirgoCoreSensorDefinition,
  XIRGO_CORE_SENSOR_DEFINITIONS,
} from './xirgo-sensor-definitions';

describe('Xirgo core sensor definitions', () => {
  it('contains unique Xirgo sensor IDs', () => {
    const ids = XIRGO_CORE_SENSOR_DEFINITIONS.map((x) => x.vendorSensorId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defines ECU engine hours correctly', () => {
    const def = getXirgoCoreSensorDefinition(16386);
    expect(def).toMatchObject({
      parameterCode: 'TOTAL_ENGINE_HOURS',
      unit: 'h',
      multiplier: 0.05,
      offset: 0,
      dataSource: TelemetryDataSource.ECU_CAN,
    });
  });

  it('defines ECU total distance correctly', () => {
    const def = getXirgoCoreSensorDefinition(16387);
    expect(def).toMatchObject({
      parameterCode: 'TOTAL_DISTANCE',
      unit: 'km',
      multiplier: 0.005,
      dataSource: TelemetryDataSource.ECU_CAN,
    });
  });

  it('keeps GNSS distance separate from ECU distance', () => {
    const def = getXirgoCoreSensorDefinition(45058);
    expect(def).toMatchObject({
      parameterCode: 'GNSS_DISTANCE',
      unit: 'm',
      multiplier: 0.0001,
      dataSource: TelemetryDataSource.GNSS,
    });
  });

  it('defines high-resolution fuel and distance counters', () => {
    expect(getXirgoCoreSensorDefinition(16474)).toMatchObject({
      parameterCode: 'TOTAL_FUEL_USED_HIGH_RES',
      multiplier: 0.001,
      unit: 'L',
    });

    expect(getXirgoCoreSensorDefinition(16482)).toMatchObject({
      parameterCode: 'TOTAL_DISTANCE_HIGH_RES',
      multiplier: 0.005,
      unit: 'km',
    });
  });
});
