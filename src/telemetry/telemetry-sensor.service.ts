import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TelemetryDataSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TelemetrySensorService {
  constructor(private readonly prisma: PrismaService) {}

  private required(value: string | undefined, name: string) {
    const normalized = String(value || '').trim();
    if (!normalized) throw new BadRequestException(`${name} is required`);
    return normalized;
  }

  private optional(value: string | null | undefined) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return String(value).trim() || null;
  }

  private async getDevice(id: string) {
    const deviceId = this.required(id, 'Telemetry device ID');
    const device = await this.prisma.telemetryDevice.findFirst({
      where: { id: deviceId, deletedAt: null },
      select: {
        id: true,
        companyId: true,
        vendor: true,
        protocol: true,
      },
    });

    if (!device) throw new NotFoundException('Telemetry device not found');
    return device;
  }

  async createDefinition(body: {
    companyId: string;
    vendor: string;
    protocol?: string | null;
    vendorSensorId: string;
    parameterCode: string;
    displayName?: string | null;
    unit?: string | null;
    multiplier?: number | null;
    offset?: number | null;
    dataSource?: TelemetryDataSource;
    metadata?: Prisma.InputJsonValue | null;
  }) {
    const companyId = this.required(body.companyId, 'Company ID');
    const vendor = this.required(body.vendor, 'Vendor').toUpperCase();
    const vendorSensorId = this.required(body.vendorSensorId, 'Vendor Sensor ID');
    const parameterCode = this.required(body.parameterCode, 'Parameter Code').toUpperCase();
    const protocol = this.optional(body.protocol);

    const company = await this.prisma.company.findFirst({
      where: { id: companyId, deletedAt: null, isActive: true },
      select: { id: true, telemetryEnabled: true },
    });

    if (!company) throw new BadRequestException('Company not found or inactive');
    if (!company.telemetryEnabled) {
      throw new BadRequestException('Telemetry is disabled for this company');
    }

    const duplicate = await this.prisma.telemetrySensorDefinition.findFirst({
      where: {
        companyId,
        vendor,
        protocol: protocol ?? null,
        vendorSensorId,
      },
      select: { id: true },
    });

    if (duplicate) {
      throw new BadRequestException('Sensor definition already exists');
    }

    return this.prisma.telemetrySensorDefinition.create({
      data: {
        companyId,
        vendor,
        protocol: protocol ?? null,
        vendorSensorId,
        parameterCode,
        displayName: this.optional(body.displayName) ?? null,
        unit: this.optional(body.unit) ?? null,
        multiplier: body.multiplier ?? 1,
        offset: body.offset ?? 0,
        dataSource: body.dataSource ?? TelemetryDataSource.UNKNOWN,
        metadata:
          body.metadata === undefined
            ? undefined
            : body.metadata === null
              ? Prisma.JsonNull
              : body.metadata,
        // Any sensor added from the web starts disabled for every device.
        isActive: false,
      },
    });
  }

  async listForDevice(deviceId: string) {
    const device = await this.getDevice(deviceId);

    const definitions = await this.prisma.telemetrySensorDefinition.findMany({
      where: {
        vendor: device.vendor,
        OR: [{ companyId: device.companyId }, { companyId: null }],
      },
      orderBy: [{ vendorSensorId: 'asc' }, { createdAt: 'asc' }],
    });

    // Company-specific definition wins over the global definition for the same
    // vendor sensor ID, matching the ingestion precedence rule.
    const selectedByVendorSensorId = new Map<string, (typeof definitions)[number]>();

    for (const definition of definitions) {
      const current = selectedByVendorSensorId.get(definition.vendorSensorId);
      if (!current || definition.companyId === device.companyId) {
        selectedByVendorSensorId.set(definition.vendorSensorId, definition);
      }
    }

    const selectedDefinitions = [...selectedByVendorSensorId.values()];
    const definitionIds = selectedDefinitions.map((definition) => definition.id);

    const settings = definitionIds.length
      ? await this.prisma.telemetryDeviceSensor.findMany({
          where: {
            deviceId: device.id,
            sensorDefinitionId: { in: definitionIds },
          },
          select: {
            sensorDefinitionId: true,
            isEnabled: true,
          },
        })
      : [];

    const overrideByDefinitionId = new Map(
      settings.map((setting) => [setting.sensorDefinitionId, setting.isEnabled]),
    );

    return selectedDefinitions.map((definition) => ({
      ...definition,
      isEnabled:
        overrideByDefinitionId.get(definition.id) ?? definition.isActive,
      hasDeviceOverride: overrideByDefinitionId.has(definition.id),
    }));
  }

  async setDeviceSensorEnabled(
    deviceId: string,
    sensorDefinitionId: string,
    isEnabled: boolean,
  ) {
    const device = await this.getDevice(deviceId);
    const definitionId = this.required(sensorDefinitionId, 'Sensor definition ID');

    if (typeof isEnabled !== 'boolean') {
      throw new BadRequestException('isEnabled must be boolean');
    }

    const definition = await this.prisma.telemetrySensorDefinition.findFirst({
      where: {
        id: definitionId,
        vendor: device.vendor,
        OR: [{ companyId: device.companyId }, { companyId: null }],
      },
      select: { id: true },
    });

    if (!definition) {
      throw new BadRequestException(
        'Sensor definition does not belong to this device vendor/company',
      );
    }

    return this.prisma.telemetryDeviceSensor.upsert({
      where: {
        deviceId_sensorDefinitionId: {
          deviceId: device.id,
          sensorDefinitionId: definition.id,
        },
      },
      update: { isEnabled },
      create: {
        deviceId: device.id,
        sensorDefinitionId: definition.id,
        isEnabled,
      },
      include: {
        sensorDefinition: true,
      },
    });
  }
}
