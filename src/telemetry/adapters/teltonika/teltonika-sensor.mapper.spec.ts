import { TelemetryDataSource } from '@prisma/client';
import { TeltonikaSensorMapper } from './teltonika-sensor.mapper';

describe('TeltonikaSensorMapper', () => {
  const mapper = new TeltonikaSensorMapper();

  it('maps engine worktime from minutes to hours', () => {
    const result = mapper.map(
      {
        avlId: 14,
        length: 4,
        value: 600,
        rawHex: '00000258',
      },
      {
        id: 'engine-hours-definition',
        vendorSensorId: '14',
        parameterCode: 'TOTAL_ENGINE_HOURS',
        displayName: 'Engine Worktime',
        unit: 'h',
        multiplier: 1 / 60,
        offset: 0,
        dataSource: TelemetryDataSource.ECU_CAN,
        signed: false,
        isActive: true,
      },
    );

    expect(result.numericValue).toBe(10);
    expect(result.unit).toBe('h');
    expect(result.parameterCode).toBe('TOTAL_ENGINE_HOURS');
  });

  it('maps total fuel used using the official 0.1 L multiplier', () => {
    const result = mapper.map(
      {
        avlId: 33,
        length: 4,
        value: 12345,
        rawHex: '00003039',
      },
      {
        vendorSensorId: '33',
        parameterCode: 'TOTAL_FUEL_USED',
        displayName: 'Fuel Consumed',
        unit: 'L',
        multiplier: 0.1,
        offset: 0,
        dataSource: TelemetryDataSource.ECU_CAN,
        signed: false,
        isActive: true,
      },
    );

    expect(result.numericValue).toBe(1234.5);
    expect(result.unit).toBe('L');
  });

  it('maps total mileage from meters to kilometers', () => {
    const result = mapper.map(
      {
        avlId: 36,
        length: 4,
        value: 1234567,
        rawHex: '0012d687',
      },
      {
        vendorSensorId: '36',
        parameterCode: 'TOTAL_DISTANCE',
        displayName: 'Total Mileage',
        unit: 'km',
        multiplier: 0.001,
        offset: 0,
        dataSource: TelemetryDataSource.ECU_CAN,
        signed: false,
        isActive: true,
      },
    );

    expect(result.numericValue).toBeCloseTo(1234.567, 6);
  });

  it('interprets signed two-byte engine temperature before scaling', () => {
    const result = mapper.map(
      {
        avlId: 25,
        length: 2,
        value: 0xff9c,
        rawHex: 'ff9c',
      },
      {
        vendorSensorId: '25',
        parameterCode: 'ENGINE_TEMPERATURE',
        displayName: 'Engine Temperature',
        unit: '°C',
        multiplier: 0.1,
        offset: 0,
        dataSource: TelemetryDataSource.ECU_CAN,
        signed: true,
        isActive: true,
      },
    );

    expect(result.numericValue).toBe(-10);
  });

  it('keeps unknown AVL IDs instead of dropping them', () => {
    const result = mapper.map(
      {
        avlId: 9999,
        length: 2,
        value: 321,
        rawHex: '0141',
      },
      null,
    );

    expect(result.parameterCode).toBe('TELTONIKA_AVL_9999');
    expect(result.numericValue).toBe(321);
    expect(result.dataSource).toBe(TelemetryDataSource.UNKNOWN);
  });
});
