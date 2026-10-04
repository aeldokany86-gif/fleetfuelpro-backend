import { XirgoIotmAdapter } from './xirgo/xirgo-iotm.adapter';
import { TeltonikaCodec8ExtendedAdapter } from './teltonika/teltonika-codec8e.adapter';
import { TelemetryAdapterRegistry } from './telemetry-adapter.registry';

describe('TelemetryAdapterRegistry', () => {
  const registry = new TelemetryAdapterRegistry(
    new XirgoIotmAdapter(),
    new TeltonikaCodec8ExtendedAdapter(),
  );

  it('registers Xirgo XG_IOTM as a supported protocol', () => {
    expect(registry.supports('XIRGO', 'XG_IOTM')).toBe(true);
  });

  it('registers Teltonika Codec 8 Extended as a supported protocol', () => {
    expect(registry.supports('TELTONIKA', 'CODEC_8_EXTENDED')).toBe(true);
  });

  it('normalizes vendor and protocol casing', () => {
    expect(registry.supports('xirgo', 'xg_iotm')).toBe(true);
    expect(
      registry.supports('teltonika', 'codec_8_extended'),
    ).toBe(true);
  });

  it('rejects unsupported protocols', () => {
    expect(() => registry.resolve('UNKNOWN', 'UNKNOWN_PROTOCOL')).toThrow(
      'Unsupported telemetry protocol',
    );
  });
});
