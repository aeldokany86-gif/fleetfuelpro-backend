import { TeltonikaSensorDefinitionSeeder } from './teltonika-sensor-definition.seeder';
import { TELTONIKA_FMC650_CORE_SENSOR_DEFINITIONS } from './teltonika-sensor-definitions';

describe('TeltonikaSensorDefinitionSeeder', () => {
  it('previews CREATE when a global definition does not exist', async () => {
    const client = {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    };

    const seeder = new TeltonikaSensorDefinitionSeeder(client);
    const preview = await seeder.preview();

    expect(preview).toHaveLength(
      TELTONIKA_FMC650_CORE_SENSOR_DEFINITIONS.length,
    );
    expect(preview.every((x) => x.action === 'CREATE')).toBe(true);
    expect(client.create).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
  });

  it('creates missing definitions', async () => {
    const client = {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn(),
    };

    const seeder = new TeltonikaSensorDefinitionSeeder(client);
    const result = await seeder.seed();

    expect(result.created).toBe(
      TELTONIKA_FMC650_CORE_SENSOR_DEFINITIONS.length,
    );
    expect(result.updated).toBe(0);
  });

  it('stores definitions as global Teltonika Codec 8 Extended definitions', async () => {
    const client = {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn(),
    };

    const seeder = new TeltonikaSensorDefinitionSeeder(client);
    await seeder.seed();

    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          companyId: null,
          vendor: 'TELTONIKA',
          protocol: 'CODEC_8_EXTENDED',
          metadata: expect.objectContaining({
            deviceProfile: 'FMC650_CAN_ADAPTER',
          }),
        }),
      }),
    );
  });
});
