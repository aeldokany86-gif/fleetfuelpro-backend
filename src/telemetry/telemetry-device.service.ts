import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TelemetryDeviceStatus,
  TelemetryTransport,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TelemetryDeviceService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeRequired(value: string | undefined, fieldName: string) {
    const normalized = String(value || '').trim();

    if (!normalized) {
      throw new BadRequestException(`${fieldName} is required`);
    }

    return normalized;
  }

  private normalizeOptional(value: string | null | undefined) {
    if (value === undefined) return undefined;
    if (value === null) return null;

    const normalized = String(value).trim();
    return normalized || null;
  }

  private normalizeVendor(value: string | undefined) {
    return this.normalizeRequired(value, 'Vendor').toUpperCase();
  }

  private normalizeHardwareId(value: string | undefined) {
    return this.normalizeRequired(value, 'Hardware ID');
  }

  private async ensureCompany(companyId: string) {
    const company = await this.prisma.company.findFirst({
      where: {
        id: companyId,
        deletedAt: null,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        code: true,
        telemetryEnabled: true,
      },
    });

    if (!company) {
      throw new BadRequestException('Company not found or inactive');
    }

    if (!company.telemetryEnabled) {
      throw new BadRequestException(
        'Telemetry is disabled for this company',
      );
    }

    return company;
  }

  private async ensureAsset(assetId: string, companyId: string) {
    const asset = await this.prisma.asset.findFirst({
      where: {
        id: assetId,
        companyId,
        deletedAt: null,
      },
      select: {
        id: true,
        assetId: true,
        type: true,
        category: true,
        companyId: true,
        projectId: true,
        status: true,
      },
    });

    if (!asset) {
      throw new BadRequestException(
        'Asset not found, deleted, or does not belong to this company',
      );
    }

    return asset;
  }

  private deviceInclude() {
    return {
      company: {
        select: {
          id: true,
          name: true,
          code: true,
        },
      },
      asset: {
        select: {
          id: true,
          assetId: true,
          type: true,
          category: true,
          companyId: true,
          projectId: true,
          status: true,
        },
      },
    } satisfies Prisma.TelemetryDeviceInclude;
  }

  async create(body: {
    companyId: string;
    assetId?: string | null;
    vendor: string;
    model?: string | null;
    hardwareId: string;
    protocol?: string | null;
    transport?: TelemetryTransport | null;
    status?: TelemetryDeviceStatus;
    firmwareVersion?: string | null;
    metadata?: Prisma.InputJsonValue | null;
  }) {
    const companyId = this.normalizeRequired(body.companyId, 'Company ID');
    const vendor = this.normalizeVendor(body.vendor);
    const hardwareId = this.normalizeHardwareId(body.hardwareId);
    const assetId = this.normalizeOptional(body.assetId);

    await this.ensureCompany(companyId);

    if (assetId) {
      await this.ensureAsset(assetId, companyId);
    }

    const duplicate = await this.prisma.telemetryDevice.findUnique({
      where: {
        vendor_hardwareId: {
          vendor,
          hardwareId,
        },
      },
      select: {
        id: true,
        companyId: true,
        assetId: true,
        deletedAt: true,
      },
    });

    if (duplicate) {
      if (duplicate.deletedAt) {
        throw new BadRequestException(
          'This telemetry device was previously registered and cannot be registered again',
        );
      }

      throw new BadRequestException(
        'Telemetry device already exists for this vendor and hardware ID',
      );
    }

    return this.prisma.telemetryDevice.create({
      data: {
        companyId,
        assetId: assetId || null,
        vendor,
        model: this.normalizeOptional(body.model),
        hardwareId,
        protocol: this.normalizeOptional(body.protocol),
        transport: body.transport ?? null,
        status: body.status ?? TelemetryDeviceStatus.ACTIVE,
        firmwareVersion: this.normalizeOptional(body.firmwareVersion),
        ...(body.metadata !== undefined
          ? {
              metadata:
                body.metadata === null
                  ? Prisma.JsonNull
                  : body.metadata,
            }
          : {}),
      },
      include: this.deviceInclude(),
    });
  }

  async findAll(filters: {
    companyId?: string;
    assetId?: string;
    vendor?: string;
    status?: TelemetryDeviceStatus;
  }) {
    const companyId = String(filters.companyId || '').trim();
    const assetId = String(filters.assetId || '').trim();
    const vendor = String(filters.vendor || '').trim().toUpperCase();

    return this.prisma.telemetryDevice.findMany({
      where: {
        deletedAt: null,
        ...(companyId ? { companyId } : {}),
        ...(assetId ? { assetId } : {}),
        ...(vendor ? { vendor } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      include: this.deviceInclude(),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async findActiveByVendorHardwareId(vendorInput: string, hardwareIdInput: string) {
    const vendor = this.normalizeVendor(vendorInput);
    const hardwareId = this.normalizeHardwareId(hardwareIdInput);

    return this.prisma.telemetryDevice.findFirst({
      where: {
        vendor,
        hardwareId,
        status: TelemetryDeviceStatus.ACTIVE,
        deletedAt: null,
      },
      select: {
        id: true,
        companyId: true,
        assetId: true,
        vendor: true,
        model: true,
        hardwareId: true,
        protocol: true,
        transport: true,
        status: true,
        lastSeenAt: true,
      },
    });
  }

  async findOne(id: string) {
    const deviceId = this.normalizeRequired(id, 'Telemetry device ID');

    const device = await this.prisma.telemetryDevice.findFirst({
      where: {
        id: deviceId,
        deletedAt: null,
      },
      include: this.deviceInclude(),
    });

    if (!device) {
      throw new NotFoundException('Telemetry device not found');
    }

    return device;
  }

  async update(
    id: string,
    body: {
      hardwareId?: string;
      model?: string | null;
      protocol?: string | null;
      transport?: TelemetryTransport | null;
      status?: TelemetryDeviceStatus;
      firmwareVersion?: string | null;
      metadata?: Prisma.InputJsonValue | null;
    },
  ) {
    const existing = await this.findOne(id);

    let hardwareId: string | undefined;

    if (body.hardwareId !== undefined) {
      hardwareId = this.normalizeHardwareId(body.hardwareId);

      if (hardwareId !== existing.hardwareId) {
        const duplicate = await this.prisma.telemetryDevice.findUnique({
          where: {
            vendor_hardwareId: {
              vendor: existing.vendor,
              hardwareId,
            },
          },
          select: {
            id: true,
            deletedAt: true,
          },
        });

        if (duplicate && duplicate.id !== existing.id) {
          if (duplicate.deletedAt) {
            throw new BadRequestException(
              'This telemetry device hardware ID was previously registered and cannot be reused',
            );
          }

          throw new BadRequestException(
            'Telemetry device already exists for this vendor and hardware ID',
          );
        }
      }
    }

    return this.prisma.telemetryDevice.update({
      where: { id: existing.id },
      data: {
        ...(hardwareId !== undefined ? { hardwareId } : {}),
        ...(body.model !== undefined
          ? { model: this.normalizeOptional(body.model) }
          : {}),
        ...(body.protocol !== undefined
          ? { protocol: this.normalizeOptional(body.protocol) }
          : {}),
        ...(body.transport !== undefined
          ? { transport: body.transport }
          : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.firmwareVersion !== undefined
          ? { firmwareVersion: this.normalizeOptional(body.firmwareVersion) }
          : {}),
        ...(body.metadata !== undefined
          ? {
              metadata:
                body.metadata === null
                  ? Prisma.JsonNull
                  : body.metadata,
            }
          : {}),
      },
      include: this.deviceInclude(),
    });
  }

  async getLatestTelemetry(id: string) {
    const device = await this.prisma.telemetryDevice.findFirst({
      where: {
        id,
        deletedAt: null,
      },
      select: {
        id: true,
        companyId: true,
        assetId: true,
        vendor: true,
        model: true,
        hardwareId: true,
        protocol: true,
        transport: true,
        status: true,
        firmwareVersion: true,
        lastSeenAt: true,
        company: {
          select: {
            telemetryEnabled: true,
          },
        },
        asset: {
          select: {
            id: true,
            assetId: true,
            type: true,
            category: true,
            status: true,
            projectId: true,
          },
        },
      },
    });

    if (!device) {
      throw new NotFoundException('Telemetry device not found');
    }

    if (!device.company.telemetryEnabled) {
      throw new BadRequestException(
        'Telemetry is disabled for this company',
      );
    }

    if (!device.assetId || !device.asset) {
      return {
        device: {
          id: device.id,
          companyId: device.companyId,
          vendor: device.vendor,
          model: device.model,
          hardwareId: device.hardwareId,
          protocol: device.protocol,
          transport: device.transport,
          status: device.status,
          firmwareVersion: device.firmwareVersion,
          lastSeenAt: device.lastSeenAt,
          assignmentStatus: 'UNASSIGNED',
        },
        asset: null,
        latestReadingAt: null,
        latestReceivedAt: null,
        parameterCount: 0,
        parameters: {},
      };
    }

    const readings = await this.prisma.assetTelemetryReading.findMany({
      where: {
        companyId: device.companyId,
        deviceId: device.id,
        assetId: device.assetId,
      },
      orderBy: [
        { readingAt: 'desc' },
        { receivedAt: 'desc' },
        { id: 'desc' },
      ],
      select: {
        id: true,
        parameterCode: true,
        vendorSensorId: true,
        numericValue: true,
        textValue: true,
        jsonValue: true,
        unit: true,
        dataSource: true,
        readingAt: true,
        receivedAt: true,
      },
    });

    const parameters: Record<string, unknown> = {};
    let latestReadingAt: Date | null = null;
    let latestReceivedAt: Date | null = null;

    for (const reading of readings) {
      if (parameters[reading.parameterCode] !== undefined) {
        continue;
      }

      const value =
        reading.numericValue ??
        reading.textValue ??
        reading.jsonValue ??
        null;

      parameters[reading.parameterCode] = {
        value,
        numericValue: reading.numericValue,
        textValue: reading.textValue,
        jsonValue: reading.jsonValue,
        unit: reading.unit,
        dataSource: reading.dataSource,
        vendorSensorId: reading.vendorSensorId,
        readingAt: reading.readingAt,
        receivedAt: reading.receivedAt,
      };

      if (!latestReadingAt || reading.readingAt > latestReadingAt) {
        latestReadingAt = reading.readingAt;
      }

      if (!latestReceivedAt || reading.receivedAt > latestReceivedAt) {
        latestReceivedAt = reading.receivedAt;
      }
    }

    return {
      device: {
        id: device.id,
        companyId: device.companyId,
        vendor: device.vendor,
        model: device.model,
        hardwareId: device.hardwareId,
        protocol: device.protocol,
        transport: device.transport,
        status: device.status,
        firmwareVersion: device.firmwareVersion,
        lastSeenAt: device.lastSeenAt,
        assignmentStatus: 'ASSIGNED',
      },
      asset: device.asset,
      latestReadingAt,
      latestReceivedAt,
      parameterCount: Object.keys(parameters).length,
      parameters,
    };
  }

  async assignToAsset(
    id: string,
    body: {
      companyId: string;
      assetId: string;
    },
  ) {
    const companyId = this.normalizeRequired(body.companyId, 'Company ID');
    const assetId = this.normalizeRequired(body.assetId, 'Asset ID');
    const device = await this.findOne(id);

    if (device.companyId !== companyId) {
      throw new BadRequestException(
        'Telemetry device does not belong to this company',
      );
    }

    await this.ensureCompany(companyId);
    await this.ensureAsset(assetId, companyId);

    if (device.assetId === assetId) {
      return device;
    }

    const existingAssignment = await this.prisma.telemetryDevice.findFirst({
      where: {
        companyId,
        assetId,
        deletedAt: null,
        NOT: {
          id: device.id,
        },
      },
      select: {
        id: true,
        vendor: true,
        model: true,
        hardwareId: true,
        status: true,
      },
    });

    if (existingAssignment) {
      throw new BadRequestException(
        'This asset is already assigned to another telemetry device. Unassign the existing device first.',
      );
    }

    return this.prisma.telemetryDevice.update({
      where: { id: device.id },
      data: {
        assetId,
      },
      include: this.deviceInclude(),
    });
  }

  async unassignFromAsset(
    id: string,
    body: {
      companyId: string;
    },
  ) {
    const companyId = this.normalizeRequired(body.companyId, 'Company ID');
    const device = await this.findOne(id);

    if (device.companyId !== companyId) {
      throw new BadRequestException(
        'Telemetry device does not belong to this company',
      );
    }

    await this.ensureCompany(companyId);

    if (!device.assetId) {
      return device;
    }

    return this.prisma.telemetryDevice.update({
      where: { id: device.id },
      data: {
        assetId: null,
      },
      include: this.deviceInclude(),
    });
  }

  async remove(id: string, companyIdInput?: string) {
    const companyId = this.normalizeRequired(
      companyIdInput,
      'Company ID',
    );
    const device = await this.findOne(id);

    if (device.companyId !== companyId) {
      throw new BadRequestException(
        'Telemetry device does not belong to this company',
      );
    }

    return this.prisma.telemetryDevice.update({
      where: { id: device.id },
      data: {
        assetId: null,
        status: TelemetryDeviceStatus.INACTIVE,
        deletedAt: new Date(),
      },
      include: this.deviceInclude(),
    });
  }
}
