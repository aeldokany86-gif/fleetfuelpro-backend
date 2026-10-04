export type TeltonikaGpsElement = {
  longitude: number;
  latitude: number;
  altitude: number;
  angle: number;
  satellites: number;
  speed: number;
};

export type TeltonikaIoValue = number | bigint | Buffer;

export type TeltonikaIoElement = {
  avlId: number;
  length: number;
  value: TeltonikaIoValue;
  rawHex: string;
};

export type TeltonikaCodec8ExtendedRecord = {
  timestamp: Date;
  priority: number;
  gps: TeltonikaGpsElement;
  eventIoId: number;
  totalIoCount: number;
  ioElements: TeltonikaIoElement[];
};

export type TeltonikaCodec8ExtendedPayload = {
  codecId: number;
  numberOfData1: number;
  numberOfData2: number;
  dataFieldLength: number;
  crc: number;
  calculatedCrc: number;
  checksumValid: boolean;
  records: TeltonikaCodec8ExtendedRecord[];
};

export class TeltonikaCodec8ExtendedDecoder {
  static readonly CODEC_ID = 0x8e;

  decode(input: Buffer | string): TeltonikaCodec8ExtendedPayload {
    const payload =
      typeof input === 'string'
        ? Buffer.from(input.replace(/\s+/g, ''), 'hex')
        : input;

    if (payload.length < 15) {
      throw new Error('Teltonika Codec 8 Extended payload is too short');
    }

    if (payload.readUInt32BE(0) !== 0) {
      throw new Error('Invalid Teltonika preamble');
    }

    const dataFieldLength = payload.readUInt32BE(4);
    const expectedPacketLength = 8 + dataFieldLength + 4;

    if (payload.length !== expectedPacketLength) {
      throw new Error(
        `Teltonika data field length mismatch: declared ${dataFieldLength}, packet bytes ${payload.length}`,
      );
    }

    const dataStart = 8;
    const dataEnd = dataStart + dataFieldLength;
    const data = payload.subarray(dataStart, dataEnd);

    const codecId = data.readUInt8(0);

    if (codecId !== TeltonikaCodec8ExtendedDecoder.CODEC_ID) {
      throw new Error(
        `Unsupported Teltonika codec ID: 0x${codecId.toString(16).toUpperCase()}`,
      );
    }

    const numberOfData1 = data.readUInt8(1);
    let offset = 2;
    const records: TeltonikaCodec8ExtendedRecord[] = [];

    for (let recordIndex = 0; recordIndex < numberOfData1; recordIndex += 1) {
      const parsed = this.readRecord(data, offset);
      records.push(parsed.record);
      offset = parsed.nextOffset;
    }

    this.ensure(data, offset, 1);

    const numberOfData2 = data.readUInt8(offset);
    offset += 1;

    if (numberOfData2 !== numberOfData1) {
      throw new Error(
        `Teltonika record count mismatch: ${numberOfData1} != ${numberOfData2}`,
      );
    }

    if (offset !== data.length) {
      throw new Error(
        `Unexpected bytes after Teltonika AVL records: ${data.length - offset}`,
      );
    }

    const storedCrc32Field = payload.readUInt32BE(dataEnd);
    const crc = storedCrc32Field & 0xffff;
    const calculatedCrc = this.crc16Ibm(data);

    return {
      codecId,
      numberOfData1,
      numberOfData2,
      dataFieldLength,
      crc,
      calculatedCrc,
      checksumValid: crc === calculatedCrc,
      records,
    };
  }

  private readRecord(
    buffer: Buffer,
    startOffset: number,
  ): { record: TeltonikaCodec8ExtendedRecord; nextOffset: number } {
    let offset = startOffset;

    this.ensure(buffer, offset, 24);

    const timestampMs = this.readUInt64BE(buffer, offset);
    offset += 8;

    const timestampNumber = Number(timestampMs);

    if (!Number.isSafeInteger(timestampNumber)) {
      throw new Error('Teltonika timestamp exceeds JavaScript safe integer range');
    }

    const priority = buffer.readUInt8(offset);
    offset += 1;

    const longitudeRaw = buffer.readInt32BE(offset);
    offset += 4;

    const latitudeRaw = buffer.readInt32BE(offset);
    offset += 4;

    const altitude = buffer.readInt16BE(offset);
    offset += 2;

    const angle = buffer.readUInt16BE(offset);
    offset += 2;

    const satellites = buffer.readUInt8(offset);
    offset += 1;

    const speed = buffer.readUInt16BE(offset);
    offset += 2;

    this.ensure(buffer, offset, 4);

    const eventIoId = buffer.readUInt16BE(offset);
    offset += 2;

    const totalIoCount = buffer.readUInt16BE(offset);
    offset += 2;

    const ioElements: TeltonikaIoElement[] = [];

    const oneByte = this.readFixedIoGroup(buffer, offset, 1);
    ioElements.push(...oneByte.elements);
    offset = oneByte.nextOffset;

    const twoByte = this.readFixedIoGroup(buffer, offset, 2);
    ioElements.push(...twoByte.elements);
    offset = twoByte.nextOffset;

    const fourByte = this.readFixedIoGroup(buffer, offset, 4);
    ioElements.push(...fourByte.elements);
    offset = fourByte.nextOffset;

    const eightByte = this.readFixedIoGroup(buffer, offset, 8);
    ioElements.push(...eightByte.elements);
    offset = eightByte.nextOffset;

    const variable = this.readVariableIoGroup(buffer, offset);
    ioElements.push(...variable.elements);
    offset = variable.nextOffset;

    if (ioElements.length !== totalIoCount) {
      throw new Error(
        `Teltonika IO count mismatch: declared ${totalIoCount}, decoded ${ioElements.length}`,
      );
    }

    return {
      record: {
        timestamp: new Date(timestampNumber),
        priority,
        gps: {
          longitude: longitudeRaw / 10_000_000,
          latitude: latitudeRaw / 10_000_000,
          altitude,
          angle,
          satellites,
          speed,
        },
        eventIoId,
        totalIoCount,
        ioElements,
      },
      nextOffset: offset,
    };
  }

  private readFixedIoGroup(
    buffer: Buffer,
    startOffset: number,
    valueLength: 1 | 2 | 4 | 8,
  ): { elements: TeltonikaIoElement[]; nextOffset: number } {
    let offset = startOffset;

    this.ensure(buffer, offset, 2);
    const count = buffer.readUInt16BE(offset);
    offset += 2;

    const elements: TeltonikaIoElement[] = [];

    for (let index = 0; index < count; index += 1) {
      this.ensure(buffer, offset, 2 + valueLength);

      const avlId = buffer.readUInt16BE(offset);
      offset += 2;

      const valueBuffer = buffer.subarray(offset, offset + valueLength);
      offset += valueLength;

      elements.push({
        avlId,
        length: valueLength,
        value: this.readUnsignedBigEndian(valueBuffer),
        rawHex: valueBuffer.toString('hex'),
      });
    }

    return { elements, nextOffset: offset };
  }

  private readVariableIoGroup(
    buffer: Buffer,
    startOffset: number,
  ): { elements: TeltonikaIoElement[]; nextOffset: number } {
    let offset = startOffset;

    this.ensure(buffer, offset, 2);
    const count = buffer.readUInt16BE(offset);
    offset += 2;

    const elements: TeltonikaIoElement[] = [];

    for (let index = 0; index < count; index += 1) {
      this.ensure(buffer, offset, 4);

      const avlId = buffer.readUInt16BE(offset);
      offset += 2;

      const valueLength = buffer.readUInt16BE(offset);
      offset += 2;

      this.ensure(buffer, offset, valueLength);

      const valueBuffer = Buffer.from(
        buffer.subarray(offset, offset + valueLength),
      );
      offset += valueLength;

      elements.push({
        avlId,
        length: valueLength,
        value: valueBuffer,
        rawHex: valueBuffer.toString('hex'),
      });
    }

    return { elements, nextOffset: offset };
  }

  private readUnsignedBigEndian(buffer: Buffer): number | bigint {
    if (buffer.length === 8) {
      return buffer.readBigUInt64BE(0);
    }

    let value = 0;

    for (const byte of buffer) {
      value = value * 256 + byte;
    }

    return value;
  }

  private readUInt64BE(buffer: Buffer, offset: number): bigint {
    this.ensure(buffer, offset, 8);
    return buffer.readBigUInt64BE(offset);
  }

  private crc16Ibm(buffer: Buffer): number {
    let crc = 0x0000;

    for (const byte of buffer) {
      crc ^= byte;

      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 0x0001) !== 0 ? (crc >> 1) ^ 0xa001 : crc >> 1;
      }
    }

    return crc & 0xffff;
  }

  private ensure(buffer: Buffer, offset: number, length: number) {
    if (
      offset < 0 ||
      length < 0 ||
      offset + length > buffer.length
    ) {
      throw new Error(
        `Unexpected end of Teltonika Codec 8 Extended payload at offset ${offset}, need ${length} byte(s)`,
      );
    }
  }
}
