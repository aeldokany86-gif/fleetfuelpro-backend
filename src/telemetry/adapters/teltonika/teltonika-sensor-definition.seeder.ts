import { TelemetryDataSource } from '@prisma/client';
import { TELTONIKA_FMC650_CORE_SENSOR_DEFINITIONS } from './teltonika-sensor-definitions';

type SensorDefinitionRecord = {
  id: string;
};

type SensorDefinitionClient = {
  findFirst(args: any): Promise<SensorDefinitionRecord | null>;
  create(args: any): Promise<unknown>;
  update(args: any): Promise<unknown>;
};

export type TeltonikaSeedPreviewItem = {
  action: 'CREATE' | 'UPDATE';
  vendorSensorId: string;
  parameterCode: string;
};

export type TeltonikaSeedResult = {
  created: number;
  updated: number;
  total: number;
};

export class TeltonikaSensorDefinitionSeeder {
  constructor(private readonly sensorDefinitions: SensorDefinitionClient) {}

  async preview(): Promise<TeltonikaSeedPreviewItem[]> {
    const result: TeltonikaSeedPreviewItem[] = [];

    for (const definition of TELTONIKA_FMC650_CORE_SENSOR_DEFINITIONS) {
      const existing = await this.findGlobalDefinition(
        definition.vendorSensorId,
      );

      result.push({
        action: existing ? 'UPDATE' : 'CREATE',
        vendorSensorId: definition.vendorSensorId,
        parameterCode: definition.parameterCode,
      });
    }

    return result;
  }

  async seed(): Promise<TeltonikaSeedResult> {
    let created = 0;
    let updated = 0;

    for (const definition of TELTONIKA_FMC650_CORE_SENSOR_DEFINITIONS) {
      const existing = await this.findGlobalDefinition(
        definition.vendorSensorId,
      );
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
      total: TELTONIKA_FMC650_CORE_SENSOR_DEFINITIONS.length,
    };
  }

  private findGlobalDefinition(vendorSensorId: string) {
    return this.sensorDefinitions.findFirst({
      where: {
        companyId: null,
        vendor: 'TELTONIKA',
        protocol: 'CODEC_8_EXTENDED',
        vendorSensorId,
      },
      select: { id: true },
    });
  }

  private toDatabaseData(definition: {
    vendorSensorId: string;
    parameterCode: string;
    deviceProfile?: string | null;
    displayName?: string | null;
    unit?: string | null;
    multiplier?: number | null;
    offset?: number | null;
    dataSource: TelemetryDataSource;
    signed?: boolean;
    isActive?: boolean;
  }) {
    return {
      companyId: null,
      vendor: 'TELTONIKA',
      protocol: 'CODEC_8_EXTENDED',
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
        source: 'TELTONIKA_FMC650_AVL_DICTIONARY',
        deviceProfile: definition.deviceProfile ?? null,
        signed: definition.signed ?? false,
      },
    };
  }
}
