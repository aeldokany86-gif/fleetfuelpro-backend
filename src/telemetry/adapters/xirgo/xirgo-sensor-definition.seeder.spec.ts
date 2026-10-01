import { XirgoSensorDefinitionSeeder } from './xirgo-sensor-definition.seeder';
import { XIRGO_CORE_SENSOR_DEFINITIONS } from './xirgo-sensor-definitions';

describe('XirgoSensorDefinitionSeeder', () => {
  it('previews CREATE when a global definition does not exist', async () => {
    const client = {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    };

    const seeder = new XirgoSensorDefinitionSeeder(client);
    const preview = await seeder.preview();

    expect(preview).toHaveLength(XIRGO_CORE_SENSOR_DEFINITIONS.length);
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

    const seeder = new XirgoSensorDefinitionSeeder(client);
    const result = await seeder.seed();

    expect(result.created).toBe(XIRGO_CORE_SENSOR_DEFINITIONS.length);
    expect(result.updated).toBe(0);
    expect(client.create).toHaveBeenCalledTimes(
      XIRGO_CORE_SENSOR_DEFINITIONS.length,
    );
  });

  it('updates existing definitions instead of creating duplicates', async () => {
    const client = {
      findFirst: jest.fn().mockResolvedValue({ id: 'existing-definition' }),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    };

    const seeder = new XirgoSensorDefinitionSeeder(client);
    const result = await seeder.seed();

    expect(result.created).toBe(0);
    expect(result.updated).toBe(XIRGO_CORE_SENSOR_DEFINITIONS.length);
    expect(client.create).not.toHaveBeenCalled();
    expect(client.update).toHaveBeenCalledTimes(
      XIRGO_CORE_SENSOR_DEFINITIONS.length,
    );
  });

  it('stores Xirgo definitions as global definitions', async () => {
    const client = {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn(),
    };

    const seeder = new XirgoSensorDefinitionSeeder(client);
    await seeder.seed();

    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          companyId: null,
          vendor: 'XIRGO',
          protocol: 'XG_IOTM',
        }),
      }),
    );
  });
});
