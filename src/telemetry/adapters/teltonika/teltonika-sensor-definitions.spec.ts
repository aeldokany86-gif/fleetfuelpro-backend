import { TelemetryDataSource } from '@prisma/client';
import {
  getTeltonikaFmc650CoreSensorDefinition,
  TELTONIKA_FMC650_CORE_SENSOR_DEFINITIONS,
} from './teltonika-sensor-definitions';
import { TELTONIKA_FMC650_CAN_ADAPTER_PROFILE } from './teltonika-device-profile';

describe('Teltonika FMC650 audited sensor definitions', () => {
  it('contains unique AVL IDs', () => {
    const ids = TELTONIKA_FMC650_CORE_SENSOR_DEFINITIONS.map(
      (x) => x.vendorSensorId,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('scopes every definition to the FMC650 CAN adapter profile', () => {
    expect(
      TELTONIKA_FMC650_CORE_SENSOR_DEFINITIONS.every(
        (x) => x.deviceProfile === TELTONIKA_FMC650_CAN_ADAPTER_PROFILE,
      ),
    ).toBe(true);
  });

  it('maps FMC650 engine worktime minutes to normalized engine hours', () => {
    expect(getTeltonikaFmc650CoreSensorDefinition(14)).toMatchObject({
      parameterCode: 'TOTAL_ENGINE_HOURS',
      unit: 'h',
      multiplier: 1 / 60,
      dataSource: TelemetryDataSource.ECU_CAN,
    });
  });

  it('keeps counted counters separate from primary counters', () => {
    expect(getTeltonikaFmc650CoreSensorDefinition(15)).toMatchObject({
      parameterCode: 'TOTAL_ENGINE_HOURS_COUNTED',
      multiplier: 1 / 60,
    });
    expect(getTeltonikaFmc650CoreSensorDefinition(16)).toMatchObject({
      parameterCode: 'TOTAL_DISTANCE_COUNTED',
      multiplier: 0.001,
    });
    expect(getTeltonikaFmc650CoreSensorDefinition(17)).toMatchObject({
      parameterCode: 'TOTAL_FUEL_USED_COUNTED',
      multiplier: 0.1,
    });
  });

  it('maps primary fuel and distance counters using FMC650 scaling', () => {
    expect(getTeltonikaFmc650CoreSensorDefinition(33)).toMatchObject({
      parameterCode: 'TOTAL_FUEL_USED',
      multiplier: 0.1,
      unit: 'L',
    });
    expect(getTeltonikaFmc650CoreSensorDefinition(36)).toMatchObject({
      parameterCode: 'TOTAL_DISTANCE',
      multiplier: 0.001,
      unit: 'km',
    });
  });

  it('marks engine temperature as signed', () => {
    expect(getTeltonikaFmc650CoreSensorDefinition(25)).toMatchObject({
      parameterCode: 'ENGINE_TEMPERATURE',
      multiplier: 0.1,
      signed: true,
      unit: '°C',
    });
  });
});
