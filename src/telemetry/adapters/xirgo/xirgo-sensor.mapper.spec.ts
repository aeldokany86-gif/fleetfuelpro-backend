import { TelemetryDataSource } from '@prisma/client';
import { XirgoSensorMapper } from './xirgo-sensor.mapper';

describe('XirgoSensorMapper', () => {
  const mapper = new XirgoSensorMapper();

  it('maps Xirgo total engine hours using the official multiplier', () => {
    const result = mapper.map(
      {
        valueType: 6,
        sensorId: 16386,
        value: 20000,
        rawHex: '',
      },
      {
        id: 'engine-hours-definition',
        vendorSensorId: '16386',
        parameterCode: 'TOTAL_ENGINE_HOURS',
        displayName: 'Total Engine Hours',
        unit: 'h',
        multiplier: 0.05,
        offset: 0,
        dataSource: TelemetryDataSource.ECU_CAN,
        isActive: true,
      },
    );

    expect(result.numericValue).toBe(1000);
    expect(result.unit).toBe('h');
    expect(result.parameterCode).toBe('TOTAL_ENGINE_HOURS');
    expect(result.dataSource).toBe(TelemetryDataSource.ECU_CAN);
  });

  it('maps Xirgo total distance using the official multiplier', () => {
    const result = mapper.map(
      {
        valueType: 6,
        sensorId: 16387,
        value: 200000,
        rawHex: '',
      },
      {
        vendorSensorId: '16387',
        parameterCode: 'TOTAL_DISTANCE',
        displayName: 'Total Distance',
        unit: 'km',
        multiplier: 0.005,
        offset: 0,
        dataSource: TelemetryDataSource.ECU_CAN,
        isActive: true,
      },
    );

    expect(result.numericValue).toBe(1000);
    expect(result.unit).toBe('km');
  });

  it('maps engine speed using the official multiplier', () => {
    const result = mapper.map(
      {
        valueType: 5,
        sensorId: 12300,
        value: 12000,
        rawHex: '',
      },
      {
        vendorSensorId: '12300',
        parameterCode: 'ENGINE_RPM',
        displayName: 'Engine Speed',
        unit: 'rpm',
        multiplier: 0.125,
        offset: 0,
        dataSource: TelemetryDataSource.ECU_CAN,
        isActive: true,
      },
    );

    expect(result.numericValue).toBe(1500);
    expect(result.unit).toBe('rpm');
  });

  it('keeps unknown sensors instead of dropping them', () => {
    const result = mapper.map(
      {
        valueType: 5,
        sensorId: 9999,
        value: 321,
        rawHex: '',
      },
      null,
    );

    expect(result.parameterCode).toBe('XIRGO_SENSOR_9999');
    expect(result.numericValue).toBe(321);
    expect(result.dataSource).toBe(TelemetryDataSource.UNKNOWN);
  });
});
