export type XirgoGpsValue = {
  latitude: number;
  longitude: number;
  speed: number;
  hdop: number;
  satellites: number;
  course: number;
  altitude: number;
};

export type XirgoSensorValue =
  | boolean
  | number
  | bigint
  | string
  | null
  | XirgoGpsValue
  | Buffer;

export type XirgoDecodedSensor = {
  valueType: number;
  sensorId: number;
  value: XirgoSensorValue;
  rawHex: string;
};

export type XirgoDecodedRecord =
  | { type: 1; kind: 'TELEMETRY'; length: number; timestamp: Date; sensors: XirgoDecodedSensor[] }
  | { type: 2; kind: 'IMEI'; length: number; imei: string }
  | { type: number; kind: 'UNSUPPORTED'; length: number; rawHex: string };

export type XirgoDecodedPayload = {
  structureVersion: number;
  imei: string | null;
  checksum: number;
  calculatedChecksum: number;
  checksumValid: boolean;
  records: XirgoDecodedRecord[];
};

export class XirgoIotmDecoder {
  decode(input: Buffer | string): XirgoDecodedPayload {
    const payload =
      typeof input === 'string'
        ? Buffer.from(input.replace(/\s+/g, ''), 'hex')
        : input;

    if (payload.length < 2) {
      throw new Error('XG-IOTM payload is too short');
    }

    const structureVersion = payload.readUInt8(0);
    if (structureVersion !== 2) {
      throw new Error(`Unsupported XG-IOTM structure version: ${structureVersion}`);
    }

    const checksum = payload.readUInt8(payload.length - 1);
    const calculatedChecksum = this.sum8(payload.subarray(0, payload.length - 1));
    const records: XirgoDecodedRecord[] = [];
    let imei: string | null = null;
    let offset = 1;
    const recordsEnd = payload.length - 1;

    while (offset < recordsEnd) {
      this.ensure(payload, offset, 3, recordsEnd);

      const type = payload.readUInt8(offset);
      const length = payload.readUInt16LE(offset + 1);
      offset += 3;

      this.ensure(payload, offset, length, recordsEnd);
      const record = payload.subarray(offset, offset + length);

      if (type === 2) {
        if (length !== 8) throw new Error(`Invalid IMEI record length: ${length}`);
        imei = this.readUInt64LE(record, 0).toString();
        records.push({ type: 2, kind: 'IMEI', length, imei });
      } else if (type === 1) {
        if (length < 4) throw new Error('Telemetry record is shorter than timestamp');

        const unixSeconds = record.readUInt32LE(0);
        const sensors: XirgoDecodedSensor[] = [];
        let sensorOffset = 4;

        while (sensorOffset < record.length) {
          const parsed = this.readSensor(record, sensorOffset);
          sensors.push(parsed.sensor);
          sensorOffset = parsed.nextOffset;
        }

        records.push({
          type: 1,
          kind: 'TELEMETRY',
          length,
          timestamp: new Date(unixSeconds * 1000),
          sensors,
        });
      } else {
        records.push({
          type,
          kind: 'UNSUPPORTED',
          length,
          rawHex: record.toString('hex'),
        });
      }

      offset += length;
    }

    if (offset !== recordsEnd) {
      throw new Error('XG-IOTM record boundary mismatch');
    }

    return {
      structureVersion,
      imei,
      checksum,
      calculatedChecksum,
      checksumValid: checksum === calculatedChecksum,
      records,
    };
  }

  private readSensor(
    buffer: Buffer,
    offset: number,
  ): { sensor: XirgoDecodedSensor; nextOffset: number } {
    this.ensure(buffer, offset, 3, buffer.length);

    const start = offset;
    const valueType = buffer.readUInt8(offset++);
    const sensorId = buffer.readUInt16LE(offset);
    offset += 2;

    let value: XirgoSensorValue;

    switch (valueType) {
      case 0:
        value = false;
        break;
      case 1:
        value = true;
        break;
      case 2:
        value = null;
        break;
      case 3:
        value = 0;
        break;
      case 4:
        this.ensure(buffer, offset, 1, buffer.length);
        value = buffer.readUInt8(offset);
        offset += 1;
        break;
      case 5:
        this.ensure(buffer, offset, 2, buffer.length);
        value = buffer.readUInt16LE(offset);
        offset += 2;
        break;
      case 6:
        this.ensure(buffer, offset, 4, buffer.length);
        value = buffer.readUInt32LE(offset);
        offset += 4;
        break;
      case 7:
        this.ensure(buffer, offset, 8, buffer.length);
        value = this.readUInt64LE(buffer, offset);
        offset += 8;
        break;
      case 8:
        this.ensure(buffer, offset, 1, buffer.length);
        value = buffer.readInt8(offset);
        offset += 1;
        break;
      case 9:
        this.ensure(buffer, offset, 2, buffer.length);
        value = buffer.readInt16LE(offset);
        offset += 2;
        break;
      case 10:
        this.ensure(buffer, offset, 4, buffer.length);
        value = buffer.readInt32LE(offset);
        offset += 4;
        break;
      case 11:
        this.ensure(buffer, offset, 8, buffer.length);
        value = buffer.readBigInt64LE(offset);
        offset += 8;
        break;
      case 12:
        this.ensure(buffer, offset, 4, buffer.length);
        value = buffer.readFloatLE(offset);
        offset += 4;
        break;
      case 13:
        this.ensure(buffer, offset, 8, buffer.length);
        value = buffer.readDoubleLE(offset);
        offset += 8;
        break;
      case 14:
        this.ensure(buffer, offset, 16, buffer.length);
        value = {
          latitude: buffer.readFloatLE(offset),
          longitude: buffer.readFloatLE(offset + 4),
          speed: buffer.readUInt16LE(offset + 8),
          hdop: buffer.readUInt8(offset + 10),
          satellites: buffer.readUInt8(offset + 11),
          course: buffer.readUInt16LE(offset + 12),
          altitude: buffer.readInt16LE(offset + 14),
        };
        offset += 16;
        break;
      case 32:
      case 33: {
        this.ensure(buffer, offset, 1, buffer.length);
        const length = buffer.readUInt8(offset++);
        this.ensure(buffer, offset, length, buffer.length);
        const bytes = buffer.subarray(offset, offset + length);
        value = valueType === 32 ? bytes.toString('utf8') : Buffer.from(bytes);
        offset += length;
        break;
      }
      case 64:
      case 65: {
        this.ensure(buffer, offset, 2, buffer.length);
        const length = buffer.readUInt16LE(offset);
        offset += 2;
        this.ensure(buffer, offset, length, buffer.length);
        const bytes = buffer.subarray(offset, offset + length);
        value = valueType === 64 ? bytes.toString('utf8') : Buffer.from(bytes);
        offset += length;
        break;
      }
      default:
        throw new Error(
          `Unsupported XG-IOTM sensor value type ${valueType} for sensor ${sensorId}`,
        );
    }

    return {
      sensor: {
        valueType,
        sensorId,
        value,
        rawHex: buffer.subarray(start, offset).toString('hex'),
      },
      nextOffset: offset,
    };
  }

  private readUInt64LE(buffer: Buffer, offset: number): bigint {
    this.ensure(buffer, offset, 8, buffer.length);
    return buffer.readBigUInt64LE(offset);
  }

  private sum8(buffer: Buffer): number {
    let sum = 0;
    for (const byte of buffer) sum = (sum + byte) & 0xff;
    return sum;
  }

  private ensure(
    buffer: Buffer,
    offset: number,
    length: number,
    end: number,
  ) {
    if (offset < 0 || length < 0 || offset + length > end || offset + length > buffer.length) {
      throw new Error(
        `Unexpected end of XG-IOTM payload at offset ${offset}, need ${length} byte(s)`,
      );
    }
  }
}
