import { TeltonikaCodec8ExtendedDecoder } from './teltonika-codec8e.decoder';

describe('TeltonikaCodec8ExtendedDecoder', () => {
  const decoder = new TeltonikaCodec8ExtendedDecoder();

  // Official Teltonika Codec 8 Extended TCP example.
  const officialPacket =
    '000000000000004A' +
    '8E01' +
    '0000016B412CEE00' +
    '01' +
    '00000000' +
    '00000000' +
    '0000' +
    '0000' +
    '00' +
    '0000' +
    '0001' +
    '0005' +
    '0001' +
    '0001' +
    '01' +
    '0001' +
    '0011' +
    '001D' +
    '0001' +
    '0010' +
    '015E2C88' +
    '0002' +
    '000B' +
    '000000003544C87A' +
    '000E' +
    '000000001DD7E06A' +
    '0000' +
    '01' +
    '00002994';

  it('decodes the official Codec 8 Extended TCP packet', () => {
    const result = decoder.decode(officialPacket);

    expect(result.codecId).toBe(0x8e);
    expect(result.dataFieldLength).toBe(0x4a);
    expect(result.numberOfData1).toBe(1);
    expect(result.numberOfData2).toBe(1);
    expect(result.checksumValid).toBe(true);
    expect(result.crc).toBe(0x2994);

    expect(result.records).toHaveLength(1);

    const record = result.records[0];

    expect(record.timestamp.toISOString()).toBe('2019-06-10T11:36:32.000Z');
    expect(record.priority).toBe(1);
    expect(record.gps).toEqual({
      longitude: 0,
      latitude: 0,
      altitude: 0,
      angle: 0,
      satellites: 0,
      speed: 0,
    });

    expect(record.eventIoId).toBe(1);
    expect(record.totalIoCount).toBe(5);
    expect(record.ioElements).toHaveLength(5);

    expect(record.ioElements[0]).toMatchObject({
      avlId: 1,
      length: 1,
      value: 1,
    });

    expect(record.ioElements[1]).toMatchObject({
      avlId: 17,
      length: 2,
      value: 0x001d,
    });

    expect(record.ioElements[2]).toMatchObject({
      avlId: 16,
      length: 4,
      value: 0x015e2c88,
    });

    expect(record.ioElements[3]).toMatchObject({
      avlId: 11,
      length: 8,
      value: BigInt('0x000000003544C87A'),
    });

    expect(record.ioElements[4]).toMatchObject({
      avlId: 14,
      length: 8,
      value: BigInt('0x000000001DD7E06A'),
    });
  });

  it('rejects a packet with the wrong codec ID', () => {
    const packet = Buffer.from(officialPacket, 'hex');
    packet.writeUInt8(0x08, 8);

    expect(() => decoder.decode(packet)).toThrow(
      'Unsupported Teltonika codec ID',
    );
  });

  it('detects an invalid CRC without discarding the decoded packet', () => {
    const packet = Buffer.from(officialPacket, 'hex');

    packet[packet.length - 1] ^= 0xff;

    const result = decoder.decode(packet);

    expect(result.checksumValid).toBe(false);
    expect(result.calculatedCrc).toBe(0x2994);
  });

  it('rejects a packet when Number of Data 1 and Number of Data 2 differ', () => {
    const packet = Buffer.from(officialPacket, 'hex');

    // Number of Data 2 is the last byte of the data field.
    packet[8 + 0x4a - 1] = 0x02;

    expect(() => decoder.decode(packet)).toThrow(
      'Teltonika record count mismatch',
    );
  });

  it('decodes signed GPS coordinates using Teltonika 1e-7 degree scaling', () => {
    const packet = Buffer.from(officialPacket, 'hex');

    // First AVL record starts at byte 10.
    // timestamp(8) + priority(1) => longitude begins at byte 19.
    packet.writeInt32BE(547146368, 19);
    packet.writeInt32BE(-252527544, 23);

    // Recalculate CRC after changing the payload.
    const dataFieldLength = packet.readUInt32BE(4);
    const data = packet.subarray(8, 8 + dataFieldLength);

    let crc = 0;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 1) !== 0 ? (crc >> 1) ^ 0xa001 : crc >> 1;
      }
    }

    packet.writeUInt32BE(crc & 0xffff, 8 + dataFieldLength);

    const result = decoder.decode(packet);
    const gps = result.records[0].gps;

    expect(gps.longitude).toBeCloseTo(54.7146368, 7);
    expect(gps.latitude).toBeCloseTo(-25.2527544, 7);
    expect(result.checksumValid).toBe(true);
  });
});
