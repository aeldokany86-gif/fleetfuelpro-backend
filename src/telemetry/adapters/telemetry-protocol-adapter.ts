export type TelemetryProtocolAdapter<TDecoded = unknown> = {
  readonly vendor: string;
  readonly protocol: string;
  decode(payload: Buffer): TDecoded;
};

export function telemetryAdapterKey(vendor: string, protocol: string): string {
  return `${String(vendor || '').trim().toUpperCase()}::${String(protocol || '')
    .trim()
    .toUpperCase()}`;
}
