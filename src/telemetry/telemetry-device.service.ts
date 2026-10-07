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

type LatestTelemetryReadingRow = {
  id: string;
  parameterCode: string;
  vendorSensorId: string;
  numericValue: number | null;
  textValue: string | null;
  jsonValue: Prisma.JsonValue | null;
  unit: string | null;
  dataSource: string;
  readingAt: Date;
  receivedAt: Date;
};

type DailyTelemetryReadingRow = {
  id: string;
  parameterCode: string;
  vendorSensorId: string;
  numericValue: number;
  readingAt: Date;
  receivedAt: Date;
};

type DailyOperatingState = 'DRIVING' | 'IDLE' | 'ENGINE_OFF';

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

  private async getEnabledSensorDefinitionIdsForDevice(device: {
    id: string;
    companyId: string;
    vendor: string;
  }) {
    const definitions = await this.prisma.telemetrySensorDefinition.findMany({
      where: {
        vendor: device.vendor,
        OR: [{ companyId: device.companyId }, { companyId: null }],
      },
      select: {
        id: true,
        companyId: true,
        vendorSensorId: true,
        isActive: true,
      },
    });

    const selectedByVendorSensorId = new Map<
      string,
      (typeof definitions)[number]
    >();

    for (const definition of definitions) {
      const existing = selectedByVendorSensorId.get(definition.vendorSensorId);
      if (!existing || definition.companyId === device.companyId) {
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

    return selectedDefinitions
      .filter(
        (definition) =>
          overrideByDefinitionId.get(definition.id) ?? definition.isActive,
      )
      .map((definition) => definition.id);
  }

  private formatDateInTimeZone(date: Date, timeZone: string) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    const parts = formatter.formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;

    if (!year || !month || !day) {
      throw new BadRequestException('Unable to resolve company local date');
    }

    return `${year}-${month}-${day}`;
  }

  private validateDailySummaryDate(value: string | undefined) {
    const normalized = String(value || '').trim();

    if (!normalized) return null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      throw new BadRequestException('Date must use YYYY-MM-DD format');
    }

    const [year, month, day] = normalized.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));

    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      throw new BadRequestException('Invalid calendar date');
    }

    return normalized;
  }

  private resolveDailySemantic(reading: {
    vendorSensorId: string;
    parameterCode: string;
  }) {
    const vendorSensorId = String(reading.vendorSensorId || '').trim();
    const parameterCode = String(reading.parameterCode || '')
      .trim()
      .toUpperCase();

    if (
      vendorSensorId === '12300' ||
      ['RPM', 'ENGINE_RPM'].includes(parameterCode)
    ) {
      return 'RPM';
    }

    if (
      vendorSensorId === '12317' ||
      ['WHEEL_SPEED', 'VEHICLE_SPEED'].includes(parameterCode)
    ) {
      return 'WHEEL_SPEED';
    }

    if (
      vendorSensorId === '8192' ||
      ['GNSS_SPEED', 'GPS_SPEED'].includes(parameterCode)
    ) {
      return 'GNSS_SPEED';
    }

    if (
      vendorSensorId === '16387' ||
      ['TOTAL_DISTANCE', 'DISTANCE_TOTAL', 'TOTAL_ODOMETER'].includes(
        parameterCode,
      )
    ) {
      return 'TOTAL_DISTANCE';
    }

    if (
      vendorSensorId === '16385' ||
      ['TOTAL_FUEL_USED', 'FUEL_USED_TOTAL', 'CUMULATIVE_FUEL_USED'].includes(
        parameterCode,
      )
    ) {
      return 'TOTAL_FUEL_USED';
    }

    return null;
  }

  private calculatePositiveCumulativeDelta(
    readings: Array<{ readingAt: Date; value: number }>,
  ) {
    if (readings.length < 2) return 0;

    const latestByTimestamp = new Map<number, number>();

    for (const reading of readings) {
      latestByTimestamp.set(reading.readingAt.getTime(), reading.value);
    }

    const ordered = [...latestByTimestamp.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([timestamp, value]) => ({
        readingAt: new Date(timestamp),
        value,
      }));

    let total = 0;
    let previous = ordered[0]?.value ?? null;

    for (let index = 1; index < ordered.length; index += 1) {
      const current = ordered[index].value;

      if (
        previous !== null &&
        Number.isFinite(previous) &&
        Number.isFinite(current)
      ) {
        const delta = current - previous;

        // Negative movement is treated as a reset/rollover, never negative use.
        if (delta > 0) {
          total += delta;
        }
      }

      previous = current;
    }

    return total;
  }

  async getDailySummary(id: string, dateInput?: string) {
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
        status: true,
        lastSeenAt: true,
        company: {
          select: {
            telemetryEnabled: true,
            timezone: true,
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

    const timeZone = String(device.company.timezone || 'UTC').trim() || 'UTC';

    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    } catch {
      throw new BadRequestException(
        `Invalid company timezone configuration: ${timeZone}`,
      );
    }

    const requestedDate =
      this.validateDailySummaryDate(dateInput) ??
      this.formatDateInTimeZone(new Date(), timeZone);

    if (!device.assetId || !device.asset) {
      return {
        deviceId: device.id,
        asset: null,
        date: requestedDate,
        timezone: timeZone,
        todayDistanceKm: 0,
        todayFuelUsedL: 0,
        workingHours: 0,
        idleHours: 0,
        drivingHours: 0,
        timeline: [],
        thresholds: {
          engineRunningRpm: 100,
          drivingSpeedKph: 1,
          maxTelemetryGapMinutes: 5,
        },
      };
    }

    /*
     * Daily operational inputs only.
     *
     * Xirgo sensor IDs:
     * 12300 = RPM
     * 12317 = Wheel Speed
     * 8192  = GNSS Speed fallback
     * 16387 = Total Distance
     * 16385 = Total Fuel Used
     *
     * parameterCode aliases keep the endpoint usable for future adapters that
     * map the same semantics under a different vendor sensor ID.
     */
    const readings = await this.prisma.$queryRaw<DailyTelemetryReadingRow[]>(
      Prisma.sql`
        SELECT
          "id",
          "parameterCode",
          "vendorSensorId",
          "numericValue",
          "readingAt",
          "receivedAt"
        FROM "AssetTelemetryReading"
        WHERE "companyId" = ${device.companyId}
          AND "deviceId" = ${device.id}
          AND "assetId" = ${device.assetId}
          AND "numericValue" IS NOT NULL
          AND (
            "vendorSensorId" IN ('12300', '12317', '8192', '16387', '16385')
            OR UPPER("parameterCode") IN (
              'RPM',
              'ENGINE_RPM',
              'WHEEL_SPEED',
              'VEHICLE_SPEED',
              'GNSS_SPEED',
              'GPS_SPEED',
              'TOTAL_DISTANCE',
              'DISTANCE_TOTAL',
              'TOTAL_ODOMETER',
              'TOTAL_FUEL_USED',
              'FUEL_USED_TOTAL',
              'CUMULATIVE_FUEL_USED'
            )
          )
          AND "readingAt" >= (
            ${requestedDate}::date::timestamp AT TIME ZONE ${timeZone}
          )
          AND "readingAt" < (
            (${requestedDate}::date + INTERVAL '1 day')::timestamp
            AT TIME ZONE ${timeZone}
          )
        ORDER BY "readingAt" ASC, "receivedAt" ASC, "id" ASC
      `,
    );

    const rpmReadings: Array<{ readingAt: Date; value: number }> = [];
    const wheelSpeedReadings: Array<{ readingAt: Date; value: number }> = [];
    const gnssSpeedReadings: Array<{ readingAt: Date; value: number }> = [];
    const distanceReadings: Array<{ readingAt: Date; value: number }> = [];
    const fuelReadings: Array<{ readingAt: Date; value: number }> = [];

    type Snapshot = {
      at: Date;
      rpm?: number;
      wheelSpeed?: number;
      gnssSpeed?: number;
    };

    const snapshotsByTime = new Map<number, Snapshot>();

    for (const reading of readings) {
      const numericValue = Number(reading.numericValue);
      if (!Number.isFinite(numericValue)) continue;

      const semantic = this.resolveDailySemantic(reading);
      if (!semantic) continue;

      const point = {
        readingAt: reading.readingAt,
        value: numericValue,
      };

      const timestamp = reading.readingAt.getTime();
      const snapshot = snapshotsByTime.get(timestamp) ?? {
        at: reading.readingAt,
      };

      if (semantic === 'RPM') {
        rpmReadings.push(point);
        snapshot.rpm = numericValue;
      } else if (semantic === 'WHEEL_SPEED') {
        wheelSpeedReadings.push(point);
        snapshot.wheelSpeed = numericValue;
      } else if (semantic === 'GNSS_SPEED') {
        gnssSpeedReadings.push(point);
        snapshot.gnssSpeed = numericValue;
      } else if (semantic === 'TOTAL_DISTANCE') {
        distanceReadings.push(point);
      } else if (semantic === 'TOTAL_FUEL_USED') {
        fuelReadings.push(point);
      }

      snapshotsByTime.set(timestamp, snapshot);
    }

    const snapshots = [...snapshotsByTime.values()].sort(
      (a, b) => a.at.getTime() - b.at.getTime(),
    );

    const ENGINE_RUNNING_RPM = 100;
    const DRIVING_SPEED_KPH = 1;
    const MAX_GAP_MS = 5 * 60 * 1000;

    let latestRpm: number | null = null;
    let latestWheelSpeed: number | null = null;
    let latestGnssSpeed: number | null = null;

    let drivingMs = 0;
    let idleMs = 0;

    const timeline: Array<{
      state: DailyOperatingState;
      startAt: Date;
      endAt: Date;
      durationSeconds: number;
    }> = [];

    const appendTimeline = (
      state: DailyOperatingState,
      startAt: Date,
      endAt: Date,
    ) => {
      const durationMs = endAt.getTime() - startAt.getTime();
      if (durationMs <= 0) return;

      const previous = timeline[timeline.length - 1];

      if (
        previous &&
        previous.state === state &&
        previous.endAt.getTime() === startAt.getTime()
      ) {
        previous.endAt = endAt;
        previous.durationSeconds += durationMs / 1000;
        return;
      }

      timeline.push({
        state,
        startAt,
        endAt,
        durationSeconds: durationMs / 1000,
      });
    };

    for (let index = 0; index < snapshots.length; index += 1) {
      const snapshot = snapshots[index];

      if (snapshot.rpm !== undefined) latestRpm = snapshot.rpm;
      if (snapshot.wheelSpeed !== undefined) {
        latestWheelSpeed = snapshot.wheelSpeed;
      }
      if (snapshot.gnssSpeed !== undefined) {
        latestGnssSpeed = snapshot.gnssSpeed;
      }

      let endAt: Date | null = snapshots[index + 1]?.at ?? null;

      if (!endAt && requestedDate === this.formatDateInTimeZone(new Date(), timeZone)) {
        const now = new Date();
        const cappedEnd = Math.min(
          now.getTime(),
          snapshot.at.getTime() + MAX_GAP_MS,
        );

        if (cappedEnd > snapshot.at.getTime()) {
          endAt = new Date(cappedEnd);
        }
      }

      if (!endAt) continue;

      const gapMs = endAt.getTime() - snapshot.at.getTime();

      // Do not invent operating time across long telemetry outages.
      if (gapMs <= 0 || gapMs > MAX_GAP_MS || latestRpm === null) {
        continue;
      }

      const speed =
        latestWheelSpeed !== null ? latestWheelSpeed : latestGnssSpeed ?? 0;

      let state: DailyOperatingState = 'ENGINE_OFF';

      if (latestRpm > ENGINE_RUNNING_RPM) {
        if (speed > DRIVING_SPEED_KPH) {
          state = 'DRIVING';
          drivingMs += gapMs;
        } else {
          state = 'IDLE';
          idleMs += gapMs;
        }
      }

      appendTimeline(state, snapshot.at, endAt);
    }

    const todayDistanceKm =
      this.calculatePositiveCumulativeDelta(distanceReadings);
    const todayFuelUsedL =
      this.calculatePositiveCumulativeDelta(fuelReadings);

    const drivingHours = drivingMs / 3_600_000;
    const idleHours = idleMs / 3_600_000;
    const workingHours = drivingHours + idleHours;

    return {
      deviceId: device.id,
      asset: device.asset,
      date: requestedDate,
      timezone: timeZone,
      todayDistanceKm,
      todayFuelUsedL,
      workingHours,
      idleHours,
      drivingHours,
      timeline,
      thresholds: {
        engineRunningRpm: ENGINE_RUNNING_RPM,
        drivingSpeedKph: DRIVING_SPEED_KPH,
        maxTelemetryGapMinutes: MAX_GAP_MS / 60_000,
      },
      sources: {
        rpm: {
          vendorSensorId: '12300',
          points: rpmReadings.length,
        },
        speed: {
          primaryVendorSensorId: '12317',
          fallbackVendorSensorId: '8192',
          wheelSpeedPoints: wheelSpeedReadings.length,
          gnssSpeedPoints: gnssSpeedReadings.length,
        },
        totalDistance: {
          vendorSensorId: '16387',
          points: distanceReadings.length,
        },
        totalFuelUsed: {
          vendorSensorId: '16385',
          points: fuelReadings.length,
        },
      },
    };
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

    const enabledSensorDefinitionIds =
      await this.getEnabledSensorDefinitionIdsForDevice(device);

    /*
     * Performance-critical latest snapshot:
     *
     * The previous implementation loaded the entire reading history for every
     * enabled sensor and then discarded all but the newest row in Node.js.
     * As AssetTelemetryReading grows, that makes both the Sensor Readings modal
     * and the Real Time Status page progressively slower.
     *
     * PostgreSQL DISTINCT ON returns only the newest row for each enabled sensor
     * definition. The companion composite index keeps this query bounded by the
     * number of enabled sensors rather than by historical table size.
     */
    const readings = enabledSensorDefinitionIds.length
      ? await this.prisma.$queryRaw<LatestTelemetryReadingRow[]>(
          Prisma.sql`
            SELECT DISTINCT ON ("sensorDefinitionId")
              "id",
              "parameterCode",
              "vendorSensorId",
              "numericValue",
              "textValue",
              "jsonValue",
              "unit",
              "dataSource",
              "readingAt",
              "receivedAt"
            FROM "AssetTelemetryReading"
            WHERE "companyId" = ${device.companyId}
              AND "deviceId" = ${device.id}
              AND "assetId" = ${device.assetId}
              AND "sensorDefinitionId" IN (${Prisma.join(
                enabledSensorDefinitionIds,
              )})
            ORDER BY
              "sensorDefinitionId",
              "readingAt" DESC,
              "receivedAt" DESC,
              "id" DESC
          `,
        )
      : [];

    const parameters: Record<string, unknown> = {};
    let latestReadingAt: Date | null = null;
    let latestReceivedAt: Date | null = null;

    for (const reading of readings) {
      const existing = parameters[reading.parameterCode] as
        | { readingAt?: Date; receivedAt?: Date }
        | undefined;

      const existingReadingAt = existing?.readingAt
        ? new Date(existing.readingAt)
        : null;
      const existingReceivedAt = existing?.receivedAt
        ? new Date(existing.receivedAt)
        : null;

      const shouldReplace =
        !existing ||
        !existingReadingAt ||
        reading.readingAt > existingReadingAt ||
        (reading.readingAt.getTime() === existingReadingAt.getTime() &&
          (!existingReceivedAt || reading.receivedAt > existingReceivedAt));

      if (shouldReplace) {
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
      }

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
