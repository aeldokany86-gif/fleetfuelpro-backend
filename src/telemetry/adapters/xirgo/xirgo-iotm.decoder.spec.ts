import { XirgoIotmDecoder } from './xirgo-iotm.decoder';

describe('XirgoIotmDecoder', () => {
  const decoder = new XirgoIotmDecoder();

  const buildSensorPayload = (
    sensorId: number,
    rawValue: number,
    unixSeconds = 1504501792,
  ): string => {
    const structureVersion = Buffer.from([0x02]);

    // Official sample IMEI record:
    // IMEI = 865209039554705
    const imeiRecord = Buffer.from([
      0x02,
      0x08, 0x00,
      0x91, 0x88, 0x75, 0x2d, 0xe7, 0x12, 0x03, 0x00,
    ]);

    // XG-IOTM telemetry record:
    // 01       = telemetry record type
    // 09 00    = 9 bytes after the record header
    // 4 bytes  = Unix timestamp, little-endian
    // 05       = unsigned 16-bit sensor value
    // 2 bytes  = sensor ID, little-endian
    // 2 bytes  = raw sensor value, little-endian
    const telemetryRecord = Buffer.alloc(12);
    telemetryRecord.writeUInt8(0x01, 0);
    telemetryRecord.writeUInt16LE(9, 1);
    telemetryRecord.writeUInt32LE(unixSeconds, 3);
    telemetryRecord.writeUInt8(0x05, 7);
    telemetryRecord.writeUInt16LE(sensorId, 8);
    telemetryRecord.writeUInt16LE(rawValue, 10);

    const withoutChecksum = Buffer.concat([
      structureVersion,
      imeiRecord,
      telemetryRecord,
    ]);

    const checksum = withoutChecksum.reduce(
      (sum, byte) => (sum + byte) & 0xff,
      0,
    );

    return Buffer.concat([
      withoutChecksum,
      Buffer.from([checksum]),
    ])
      .toString('hex')
      .match(/.{1,2}/g)!
      .join(' ')
      .toUpperCase();
  };

  const buildMultiSensorPayload = (
    sensors: Array<{ sensorId: number; rawValue: number }>,
    unixSeconds = 1504501792,
  ): string => {
    const structureVersion = Buffer.from([0x02]);

    const imeiRecord = Buffer.from([
      0x02,
      0x08, 0x00,
      0x91, 0x88, 0x75, 0x2d, 0xe7, 0x12, 0x03, 0x00,
    ]);

    // Each test sensor uses XG-IOTM value type 0x05 (unsigned 16-bit):
    // 1 byte value type + 2 byte sensor ID + 2 byte value = 5 bytes/sensor.
    const telemetryPayloadLength = 4 + sensors.length * 5;
    const telemetryRecord = Buffer.alloc(3 + telemetryPayloadLength);

    telemetryRecord.writeUInt8(0x01, 0);
    telemetryRecord.writeUInt16LE(telemetryPayloadLength, 1);
    telemetryRecord.writeUInt32LE(unixSeconds, 3);

    let offset = 7;
    for (const sensor of sensors) {
      telemetryRecord.writeUInt8(0x05, offset);
      telemetryRecord.writeUInt16LE(sensor.sensorId, offset + 1);
      telemetryRecord.writeUInt16LE(sensor.rawValue, offset + 3);
      offset += 5;
    }

    const withoutChecksum = Buffer.concat([
      structureVersion,
      imeiRecord,
      telemetryRecord,
    ]);

    const checksum = withoutChecksum.reduce(
      (sum, byte) => (sum + byte) & 0xff,
      0,
    );

    return Buffer.concat([withoutChecksum, Buffer.from([checksum])])
      .toString('hex')
      .match(/.{1,2}/g)!
      .join(' ')
      .toUpperCase();
  };

  it('decodes the official XG-IOTM v2 sample', () => {
    const hex =
      '02 02 08 00 91 88 75 2D E7 12 03 00 ' +
      '01 09 00 20 00 AD 59 05 00 30 96 35 ' +
      'F3';

    const result = decoder.decode(hex);

    expect(result.structureVersion).toBe(2);
    expect(result.imei).toBe('865209039554705');
    expect(result.checksumValid).toBe(true);

    const telemetry = result.records.find(
      (record) => record.kind === 'TELEMETRY',
    );

    expect(telemetry).toBeDefined();

    if (!telemetry || telemetry.kind !== 'TELEMETRY') {
      throw new Error('Telemetry record not decoded');
    }

    const sensor12288 = telemetry.sensors.find(
      (sensor) => sensor.sensorId === 12288,
    );

    expect(sensor12288).toBeDefined();
    expect(sensor12288?.value).toBe(13718);
  });

  it('decodes TOTAL_ENGINE_HOURS sensor 16386 from a valid XG-IOTM v2 payload', () => {
    const rawEngineHours = 20000;
    const hex = buildSensorPayload(16386, rawEngineHours);

    const result = decoder.decode(hex);

    expect(result.structureVersion).toBe(2);
    expect(result.imei).toBe('865209039554705');
    expect(result.checksumValid).toBe(true);

    const telemetry = result.records.find(
      (record) => record.kind === 'TELEMETRY',
    );

    expect(telemetry).toBeDefined();

    if (!telemetry || telemetry.kind !== 'TELEMETRY') {
      throw new Error('Telemetry record not decoded');
    }

    const engineHoursSensor = telemetry.sensors.find(
      (sensor) => sensor.sensorId === 16386,
    );

    expect(engineHoursSensor).toBeDefined();
    expect(engineHoursSensor?.valueType).toBe(5);
    expect(engineHoursSensor?.value).toBe(rawEngineHours);

    // Print the exact valid payload so it can be reused in the E2E API test.
    console.log('ENGINE_HOURS_E2E_HEX=' + hex);
  });

  it('decodes TOTAL_DISTANCE sensor 16387 from a valid XG-IOTM v2 payload', () => {
    const rawTotalDistance = 20000;
    const hex = buildSensorPayload(16387, rawTotalDistance);

    const result = decoder.decode(hex);

    expect(result.structureVersion).toBe(2);
    expect(result.imei).toBe('865209039554705');
    expect(result.checksumValid).toBe(true);

    const telemetry = result.records.find(
      (record) => record.kind === 'TELEMETRY',
    );

    expect(telemetry).toBeDefined();

    if (!telemetry || telemetry.kind !== 'TELEMETRY') {
      throw new Error('Telemetry record not decoded');
    }

    const totalDistanceSensor = telemetry.sensors.find(
      (sensor) => sensor.sensorId === 16387,
    );

    expect(totalDistanceSensor).toBeDefined();
    expect(totalDistanceSensor?.valueType).toBe(5);
    expect(totalDistanceSensor?.value).toBe(rawTotalDistance);

    console.log('TOTAL_DISTANCE_E2E_HEX=' + hex);
  });

  it('decodes six core equipment sensors from one valid XG-IOTM v2 telemetry record', () => {
    const expectedSensors = [
      { sensorId: 141, rawValue: 1 },       // ENGINE_WORKING = ON
      { sensorId: 159, rawValue: 1 },       // CAN_ACTIVITY_PRESENT = YES
      { sensorId: 12318, rawValue: 350 },   // FUEL_LEVEL_L = 350 L
      { sensorId: 16385, rawValue: 2000 },  // TOTAL_FUEL_USED = 1000 L after mapping
      { sensorId: 16386, rawValue: 20000 }, // TOTAL_ENGINE_HOURS = 1000 h after mapping
      { sensorId: 16387, rawValue: 20000 }, // TOTAL_DISTANCE = 100 km after mapping
    ];

    const hex = buildMultiSensorPayload(expectedSensors);
    const result = decoder.decode(hex);

    expect(result.structureVersion).toBe(2);
    expect(result.imei).toBe('865209039554705');
    expect(result.checksumValid).toBe(true);

    const telemetry = result.records.find(
      (record) => record.kind === 'TELEMETRY',
    );

    expect(telemetry).toBeDefined();

    if (!telemetry || telemetry.kind !== 'TELEMETRY') {
      throw new Error('Telemetry record not decoded');
    }

    expect(telemetry.sensors).toHaveLength(6);

    for (const expected of expectedSensors) {
      const sensor = telemetry.sensors.find(
        (item) => item.sensorId === expected.sensorId,
      );

      expect(sensor).toBeDefined();
      expect(sensor?.valueType).toBe(5);
      expect(sensor?.value).toBe(expected.rawValue);
    }

    console.log('SIX_SENSORS_E2E_HEX=' + hex);
  });

});
