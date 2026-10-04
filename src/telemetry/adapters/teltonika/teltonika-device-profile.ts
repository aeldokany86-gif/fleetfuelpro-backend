export const TELTONIKA_FMC650_CAN_ADAPTER_PROFILE =
  'FMC650_CAN_ADAPTER' as const;

export type TeltonikaDeviceProfile =
  | typeof TELTONIKA_FMC650_CAN_ADAPTER_PROFILE;

export function resolveTeltonikaDeviceProfile(
  model: string | null | undefined,
): TeltonikaDeviceProfile | null {
  const normalized = String(model || '').trim().toUpperCase();

  if (normalized === 'FMC650') {
    return TELTONIKA_FMC650_CAN_ADAPTER_PROFILE;
  }

  return null;
}
