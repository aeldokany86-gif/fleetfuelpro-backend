import {
  TeltonikaCodec8ExtendedDecoder,
  TeltonikaIoElement,
} from './teltonika-codec8e.decoder';
import { TeltonikaSensorMapper } from './teltonika-sensor.mapper';
import { getTeltonikaFmc650CoreSensorDefinition } from './teltonika-sensor-definitions';

function crc16Ibm(buffer: Buffer): number {
  let crc = 0;

  for (const byte of buffer) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }

  return crc & 0xffff;
}

function valueBuffer(length: number, value: number): Buffer {
  const buffer = Buffer.alloc(length);

  if (length === 1) buffer.writeUInt8(value, 0);
  else if (length === 2) buffer.writeUInt16BE(value, 0);
  else if (length === 4) buffer.writeUInt32BE(value, 0);
  else throw new Error(`Unsupported semantic test value length: ${length}`);

  return buffer;
}

function ioGroup(
  length: 1 | 2 | 4,
  values: Array<{ avlId: number; value: number }>,
): Buffer {
  const parts: Buffer[] = [];
  const count = Buffer.alloc(2);
  count.writeUInt16BE(values.length, 0);
  parts.push(count);

  for (const item of values) {
    const id = Buffer.alloc(2);
    id.writeUInt16BE(item.avlId, 0);
    parts.push(id, valueBuffer(length, item.value));
  }

  return Buffer.concat(parts);
}

function buildFmc650SemanticPacket(): Buffer {
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(Date.UTC(2026, 9, 4, 20, 0, 0)), 0);

  const gps = Buffer.alloc(15);
  // All GPS fields intentionally zero for this semantic CAN mapping test.

  const oneByte = ioGroup(1, [
    { avlId: 239, value: 1 }, // Ignition ON
    { avlId: 23, value: 72 }, // Engine load 72%
    { avlId: 30, value: 45 }, // Vehicle speed 45 km/h
    { avlId: 31, value: 30 }, // Accelerator 30%
    { avlId: 37, value: 65 }, // Fuel level 65%
  ]);

  const twoByte = ioGroup(2, [
    { avlId: 18, value: 123 }, // 12.3 L/h
    { avlId: 25, value: 850 }, // 85.0 C
    { avlId: 34, value: 3500 }, // 350.0 L
    { avlId: 35, value: 1500 }, // 1500 rpm
  ]);

  const fourByte = ioGroup(4, [
    { avlId: 14, value: 600 }, // 600 min = 10 h
    { avlId: 15, value: 660 }, // 660 min = 11 h
    { avlId: 16, value: 1234567 }, // 1234.567 km
    { avlId: 17, value: 12345 }, // 1234.5 L
    { avlId: 33, value: 25000 }, // 2500.0 L
    { avlId: 36, value: 9876543 }, // 9876.543 km
  ]);

  const eightByteCount = Buffer.from([0x00, 0x00]);
  const variableCount = Buffer.from([0x00, 0x00]);

  const ioCount = 5 + 4 + 6;
  const eventAndCount = Buffer.alloc(4);
  eventAndCount.writeUInt16BE(239, 0);
  eventAndCount.writeUInt16BE(ioCount, 2);

  const record = Buffer.concat([
    timestamp,
    Buffer.from([0x01]),
    gps,
    eventAndCount,
    oneByte,
    twoByte,
    fourByte,
    eightByteCount,
    variableCount,
  ]);

  const data = Buffer.concat([
    Buffer.from([0x8e, 0x01]),
    record,
    Buffer.from([0x01]),
  ]);

  const packet = Buffer.alloc(8 + data.length + 4);
  packet.writeUInt32BE(0, 0);
  packet.writeUInt32BE(data.length, 4);
  data.copy(packet, 8);
  packet.writeUInt32BE(crc16Ibm(data), 8 + data.length);

  return packet;
}

describe('Teltonika FMC650 semantic QA', () => {
  const decoder = new TeltonikaCodec8ExtendedDecoder();
  const mapper = new TeltonikaSensorMapper();

  it('decodes and normalizes FMC650 CAN adapter values with the audited profile', () => {
    const decoded = decoder.decode(buildFmc650SemanticPacket());

    expect(decoded.checksumValid).toBe(true);
    expect(decoded.records).toHaveLength(1);

    const ioById = new Map<number, TeltonikaIoElement>(
      decoded.records[0].ioElements.map((io) => [io.avlId, io]),
    );

    const mapValue = (avlId: number) =>
      mapper.map(
        ioById.get(avlId)!,
        getTeltonikaFmc650CoreSensorDefinition(avlId),
      );

    expect(mapValue(239).numericValue).toBe(1);
    expect(mapValue(14)).toMatchObject({
      parameterCode: 'TOTAL_ENGINE_HOURS',
      numericValue: 10,
      unit: 'h',
    });
    expect(mapValue(15)).toMatchObject({
      parameterCode: 'TOTAL_ENGINE_HOURS_COUNTED',
      numericValue: 11,
      unit: 'h',
    });
    expect(mapValue(16)).toMatchObject({
      parameterCode: 'TOTAL_DISTANCE_COUNTED',
      numericValue: 1234.567,
      unit: 'km',
    });
    expect(mapValue(17)).toMatchObject({
      parameterCode: 'TOTAL_FUEL_USED_COUNTED',
      numericValue: 1234.5,
      unit: 'L',
    });
    expect(mapValue(18)).toMatchObject({
      parameterCode: 'FUEL_RATE',
      numericValue: 12.3,
      unit: 'L/h',
    });
    expect(mapValue(23)).toMatchObject({
      parameterCode: 'ENGINE_LOAD',
      numericValue: 72,
      unit: '%',
    });
    expect(mapValue(25)).toMatchObject({
      parameterCode: 'ENGINE_TEMPERATURE',
      numericValue: 85,
      unit: '°C',
    });
    expect(mapValue(30)).toMatchObject({
      parameterCode: 'VEHICLE_SPEED',
      numericValue: 45,
      unit: 'km/h',
    });
    expect(mapValue(31)).toMatchObject({
      parameterCode: 'ACCELERATOR_PEDAL_POSITION',
      numericValue: 30,
      unit: '%',
    });
    expect(mapValue(33)).toMatchObject({
      parameterCode: 'TOTAL_FUEL_USED',
      numericValue: 2500,
      unit: 'L',
    });
    expect(mapValue(34)).toMatchObject({
      parameterCode: 'FUEL_LEVEL_L',
      numericValue: 350,
      unit: 'L',
    });
    expect(mapValue(35)).toMatchObject({
      parameterCode: 'ENGINE_RPM',
      numericValue: 1500,
      unit: 'rpm',
    });
    expect(mapValue(36)).toMatchObject({
      parameterCode: 'TOTAL_DISTANCE',
      numericValue: 9876.543,
      unit: 'km',
    });
    expect(mapValue(37)).toMatchObject({
      parameterCode: 'FUEL_LEVEL_PERCENT',
      numericValue: 65,
      unit: '%',
    });
  });
});
