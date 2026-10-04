import {
  resolveTeltonikaDeviceProfile,
  TELTONIKA_FMC650_CAN_ADAPTER_PROFILE,
} from './teltonika-device-profile';

describe('Teltonika device profile resolver', () => {
  it('resolves FMC650 to the FMC650 CAN adapter profile', () => {
    expect(resolveTeltonikaDeviceProfile('FMC650')).toBe(
      TELTONIKA_FMC650_CAN_ADAPTER_PROFILE,
    );
    expect(resolveTeltonikaDeviceProfile('fmc650')).toBe(
      TELTONIKA_FMC650_CAN_ADAPTER_PROFILE,
    );
  });

  it('does not guess a profile for unsupported Teltonika models', () => {
    expect(resolveTeltonikaDeviceProfile('FMC920')).toBeNull();
    expect(resolveTeltonikaDeviceProfile(null)).toBeNull();
  });
});
