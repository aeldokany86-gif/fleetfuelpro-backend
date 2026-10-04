import { Injectable } from '@nestjs/common';
import {
  XirgoDecodedPayload,
  XirgoIotmDecoder,
} from './xirgo-iotm.decoder';
import { TelemetryProtocolAdapter } from '../telemetry-protocol-adapter';

@Injectable()
export class XirgoIotmAdapter
  implements TelemetryProtocolAdapter<XirgoDecodedPayload>
{
  readonly vendor = 'XIRGO';
  readonly protocol = 'XG_IOTM';

  private readonly decoder = new XirgoIotmDecoder();

  decode(payload: Buffer): XirgoDecodedPayload {
    return this.decoder.decode(payload);
  }
}
