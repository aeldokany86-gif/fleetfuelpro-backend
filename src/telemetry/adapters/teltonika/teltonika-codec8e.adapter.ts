import { Injectable } from '@nestjs/common';
import {
  TeltonikaCodec8ExtendedDecoder,
  TeltonikaCodec8ExtendedPayload,
} from './teltonika-codec8e.decoder';
import { TelemetryProtocolAdapter } from '../telemetry-protocol-adapter';

@Injectable()
export class TeltonikaCodec8ExtendedAdapter
  implements TelemetryProtocolAdapter<TeltonikaCodec8ExtendedPayload>
{
  readonly vendor = 'TELTONIKA';
  readonly protocol = 'CODEC_8_EXTENDED';

  private readonly decoder = new TeltonikaCodec8ExtendedDecoder();

  decode(payload: Buffer): TeltonikaCodec8ExtendedPayload {
    return this.decoder.decode(payload);
  }
}
