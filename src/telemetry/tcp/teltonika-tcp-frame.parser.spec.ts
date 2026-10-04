import { TeltonikaTcpFrameParser } from './teltonika-tcp-frame.parser';

describe('TeltonikaTcpFrameParser', () => {
  const parser = new TeltonikaTcpFrameParser();

  it('waits for a fragmented IMEI frame and then decodes it', () => {
    const imei = '123456789012345';
    const frame = Buffer.concat([
      Buffer.from([0x00, imei.length]),
      Buffer.from(imei, 'ascii'),
    ]);

    expect(parser.tryReadImei(frame.subarray(0, 5))).toBeNull();

    expect(parser.tryReadImei(frame)).toEqual({
      imei,
      consumedBytes: frame.length,
    });
  });

  it('builds the official one-byte IMEI ACK', () => {
    expect(parser.buildImeiAck(true)).toEqual(Buffer.from([0x01]));
    expect(parser.buildImeiAck(false)).toEqual(Buffer.from([0x00]));
  });

  it('extracts one complete Codec 8 Extended AVL packet from a larger TCP buffer', () => {
    const packet = Buffer.from(
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
        '00002994',
      'hex',
    );

    const extra = Buffer.from('DEADBEEF', 'hex');
    const parsed = parser.tryReadAvlPacket(Buffer.concat([packet, extra]));

    expect(parsed).not.toBeNull();
    expect(parsed?.packet).toEqual(packet);
    expect(parsed?.consumedBytes).toBe(packet.length);
  });

  it('builds a four-byte big-endian record ACK', () => {
    expect(parser.buildRecordAck(1).toString('hex')).toBe('00000001');
    expect(parser.buildRecordAck(6).toString('hex')).toBe('00000006');
  });
});
