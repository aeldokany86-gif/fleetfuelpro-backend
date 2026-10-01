import { TelemetryDataSource } from '@prisma/client';
import { XIRGO_CORE_SENSOR_DEFINITIONS } from './xirgo-sensor-definitions';

type SensorDefinitionRecord = {
  id: string;
};

type SensorDefinitionClient = {
  findFirst(args: any): Promise<SensorDefinitionRecord | null>;
  create(args: any): Promise<unknown>;
  update(args: any): Promise<unknown>;
};

export type XirgoSeedPreviewItem = {
  action: 'CREATE' | 'UPDATE';
  vendorSensorId: string;
  parameterCode: string;
};

export type XirgoSeedResult = {
  created: number;
  updated: number;
  total: number;
};

export class XirgoSensorDefinitionSeeder {
  constructor(private readonly sensorDefinitions: SensorDefinitionClient) {}

  async preview(): Promise<XirgoSeedPreviewItem[]> {
    const result: XirgoSeedPreviewItem[] = [];

    for (const definition of XIRGO_CORE_SENSOR_DEFINITIONS) {
      const existing = await this.findGlobalDefinition(definition.vendorSensorId);

      result.push({
        action: existing ? 'UPDATE' : 'CREATE',
        vendorSensorId: definition.vendorSensorId,
        parameterCode: definition.parameterCode,
      });
    }

    return result;
  }

  async seed(): Promise<XirgoSeedResult> {
    let created = 0;
    let updated = 0;

    for (const definition of XIRGO_CORE_SENSOR_DEFINITIONS) {
      const existing = await this.findGlobalDefinition(definition.vendorSensorId);
      const data = this.toDatabaseData(definition);

      if (existing) {
        await this.sensorDefinitions.update({
          where: { id: existing.id },
          data,
        });
        updated += 1;
      } else {
        await this.sensorDefinitions.create({ data });
        created += 1;
      }
    }

    return {
      created,
      updated,
      total: XIRGO_CORE_SENSOR_DEFINITIONS.length,
    };
  }

  private findGlobalDefinition(vendorSensorId: string) {
    return this.sensorDefinitions.findFirst({
      where: {
        companyId: null,
        vendor: 'XIRGO',
        protocol: 'XG_IOTM',
        vendorSensorId,
      },
      select: { id: true },
    });
  }

  private toDatabaseData(definition: {
    vendorSensorId: string;
    parameterCode: string;
    displayName?: string | null;
    unit?: string | null;
    multiplier?: number | null;
    offset?: number | null;
    dataSource: TelemetryDataSource;
    isActive?: boolean;
  }) {
    return {
      companyId: null,
      vendor: 'XIRGO',
      protocol: 'XG_IOTM',
      vendorSensorId: definition.vendorSensorId,
      parameterCode: definition.parameterCode,
      displayName: definition.displayName ?? null,
      unit: definition.unit ?? null,
      multiplier: definition.multiplier ?? 1,
      offset: definition.offset ?? 0,
      dataSource: definition.dataSource,
      isActive: definition.isActive ?? true,
      metadata: {
        scope: 'GLOBAL_VENDOR_DEFINITION',
        source: 'XIRGO_SENSOR_DICTIONARY',
      },
    };
  }
}
