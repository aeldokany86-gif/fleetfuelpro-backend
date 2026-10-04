import { Injectable } from '@nestjs/common';
import { XirgoDecodedPayload } from './xirgo/xirgo-iotm.decoder';
import { XirgoIotmAdapter } from './xirgo/xirgo-iotm.adapter';
import { TeltonikaCodec8ExtendedPayload } from './teltonika/teltonika-codec8e.decoder';
import { TeltonikaCodec8ExtendedAdapter } from './teltonika/teltonika-codec8e.adapter';
import {
  TelemetryProtocolAdapter,
  telemetryAdapterKey,
} from './telemetry-protocol-adapter';

@Injectable()
export class TelemetryAdapterRegistry {
  private readonly adapters = new Map<string, TelemetryProtocolAdapter>();

  constructor(
    private readonly xirgoIotmAdapter: XirgoIotmAdapter,
    private readonly teltonikaCodec8ExtendedAdapter: TeltonikaCodec8ExtendedAdapter,
  ) {
    this.register(this.xirgoIotmAdapter);
    this.register(this.teltonikaCodec8ExtendedAdapter);
  }

  private register(adapter: TelemetryProtocolAdapter) {
    const key = telemetryAdapterKey(adapter.vendor, adapter.protocol);

    if (this.adapters.has(key)) {
      throw new Error(
        `Duplicate telemetry adapter registration for ${adapter.vendor}/${adapter.protocol}`,
      );
    }

    this.adapters.set(key, adapter);
  }

  supports(vendor: string, protocol: string): boolean {
    return this.adapters.has(telemetryAdapterKey(vendor, protocol));
  }

  resolve<TDecoded = unknown>(
    vendor: string,
    protocol: string,
  ): TelemetryProtocolAdapter<TDecoded> {
    const adapter = this.adapters.get(telemetryAdapterKey(vendor, protocol));

    if (!adapter) {
      throw new Error(
        `Unsupported telemetry protocol: ${String(vendor || '').trim()}/${String(
          protocol || '',
        ).trim()}`,
      );
    }

    return adapter as TelemetryProtocolAdapter<TDecoded>;
  }

  decodeXirgoIotm(payload: Buffer): XirgoDecodedPayload {
    return this.resolve<XirgoDecodedPayload>('XIRGO', 'XG_IOTM').decode(payload);
  }

  decodeTeltonikaCodec8Extended(
    payload: Buffer,
  ): TeltonikaCodec8ExtendedPayload {
    return this.resolve<TeltonikaCodec8ExtendedPayload>(
      'TELTONIKA',
      'CODEC_8_EXTENDED',
    ).decode(payload);
  }
}
