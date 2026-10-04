export type TeltonikaImeiFrame = {
  imei: string;
  consumedBytes: number;
};

export type TeltonikaAvlFrame = {
  packet: Buffer;
  consumedBytes: number;
};

export class TeltonikaTcpFrameParser {
  static readonly MAX_IMEI_LENGTH = 32;
  static readonly MAX_DATA_FIELD_LENGTH = 64 * 1024;

  tryReadImei(buffer: Buffer): TeltonikaImeiFrame | null {
    if (buffer.length < 2) return null;

    const imeiLength = buffer.readUInt16BE(0);

    if (imeiLength <= 0 || imeiLength > TeltonikaTcpFrameParser.MAX_IMEI_LENGTH) {
      throw new Error(`Invalid Teltonika IMEI length: ${imeiLength}`);
    }

    const totalLength = 2 + imeiLength;
    if (buffer.length < totalLength) return null;

    const imei = buffer.subarray(2, totalLength).toString('ascii');

    if (!/^\d+$/.test(imei)) {
      throw new Error('Invalid Teltonika IMEI payload');
    }

    return {
      imei,
      consumedBytes: totalLength,
    };
  }

  tryReadAvlPacket(buffer: Buffer): TeltonikaAvlFrame | null {
    if (buffer.length < 8) return null;

    if (buffer.readUInt32BE(0) !== 0) {
      throw new Error('Invalid Teltonika AVL preamble');
    }

    const dataFieldLength = buffer.readUInt32BE(4);

    if (
      dataFieldLength <= 0 ||
      dataFieldLength > TeltonikaTcpFrameParser.MAX_DATA_FIELD_LENGTH
    ) {
      throw new Error(
        `Invalid Teltonika AVL data field length: ${dataFieldLength}`,
      );
    }

    const totalLength = 8 + dataFieldLength + 4;
    if (buffer.length < totalLength) return null;

    return {
      packet: Buffer.from(buffer.subarray(0, totalLength)),
      consumedBytes: totalLength,
    };
  }

  buildImeiAck(accepted: boolean): Buffer {
    return Buffer.from([accepted ? 0x01 : 0x00]);
  }

  buildRecordAck(acceptedRecords: number): Buffer {
    if (
      !Number.isInteger(acceptedRecords) ||
      acceptedRecords < 0 ||
      acceptedRecords > 0xffffffff
    ) {
      throw new Error(`Invalid Teltonika accepted record count: ${acceptedRecords}`);
    }

    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(acceptedRecords, 0);
    return ack;
  }
}
