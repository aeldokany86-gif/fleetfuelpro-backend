import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

type IntegrationContext = {
  companyId: string;
  companyCode?: string;
  companyName?: string;
  clientId?: string;
  clientName?: string;
  scopes?: string[];
  costScopeEnabled?: boolean;
};

type SummaryFilters = {
  dateFrom?: string;
  dateTo?: string;
  assetCode?: string;
  projectId?: string;
};

@Injectable()
export class ExternalIntegrationService {
  constructor(private readonly prisma: PrismaService) {}

  private parseLocalDate(value: string | undefined, fieldName: string) {
    const text = String(value || '').trim();

    if (!text) {
      throw new BadRequestException(`${fieldName} is required`);
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      throw new BadRequestException(
        `${fieldName} must use YYYY-MM-DD format`,
      );
    }

    const [year, month, day] = text.split('-').map(Number);
    const probe = new Date(Date.UTC(year, month - 1, day));

    if (
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() !== month - 1 ||
      probe.getUTCDate() !== day
    ) {
      throw new BadRequestException(`${fieldName} is invalid`);
    }

    return { text, year, month, day };
  }

  private assertValidTimeZone(timeZone: string) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    } catch {
      throw new BadRequestException(
        `Company timezone is invalid: ${timeZone}`,
      );
    }
  }

  /*
    Returns the UTC offset (milliseconds) used by an IANA timezone at
    the supplied instant. Positive values are east of UTC.
  */
  private getTimeZoneOffsetMs(date: Date, timeZone: string) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });

    const parts = formatter.formatToParts(date);
    const values: Record<string, string> = {};

    for (const part of parts) {
      if (part.type !== 'literal') {
        values[part.type] = part.value;
      }
    }

    const asUtc = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );

    return asUtc - date.getTime();
  }

  /*
    Converts company-local midnight to an absolute UTC instant.

    Two passes are intentional: the first pass gets an approximate timezone
    offset and the second resolves DST/offset differences at the actual target
    instant. This keeps the API deterministic on local Windows, Fly.io, or any
    server timezone.
  */
  private localMidnightToUtc(
    localDate: {
      year: number;
      month: number;
      day: number;
    },
    timeZone: string,
  ) {
    const wallClockAsUtc = Date.UTC(
      localDate.year,
      localDate.month - 1,
      localDate.day,
      0,
      0,
      0,
      0,
    );

    let candidate = new Date(wallClockAsUtc);

    for (let pass = 0; pass < 2; pass += 1) {
      const offsetMs = this.getTimeZoneOffsetMs(candidate, timeZone);
      candidate = new Date(wallClockAsUtc - offsetMs);
    }

    return candidate;
  }

  private nextLocalDate(localDate: {
    year: number;
    month: number;
    day: number;
  }) {
    const next = new Date(
      Date.UTC(localDate.year, localDate.month - 1, localDate.day + 1),
    );

    return {
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
    };
  }

  async getOperationsSummary(
    integration: IntegrationContext,
    filters: SummaryFilters,
  ) {
    if (!integration?.companyId) {
      throw new BadRequestException(
        'Integration company context is missing',
      );
    }

    const company = await this.prisma.company.findFirst({
      where: {
        id: integration.companyId,
        deletedAt: null,
      },
      select: {
        id: true,
        code: true,
        name: true,
        timezone: true,
        currency: true,
      },
    });

    if (!company) {
      throw new BadRequestException('Integration company was not found');
    }

    const timeZone = String(company.timezone || 'UTC').trim() || 'UTC';
    this.assertValidTimeZone(timeZone);

    const localFrom = this.parseLocalDate(filters.dateFrom, 'dateFrom');
    const localTo = this.parseLocalDate(filters.dateTo, 'dateTo');

    const localFromKey = Date.UTC(
      localFrom.year,
      localFrom.month - 1,
      localFrom.day,
    );
    const localToKey = Date.UTC(
      localTo.year,
      localTo.month - 1,
      localTo.day,
    );

    if (localToKey < localFromKey) {
      throw new BadRequestException(
        'dateTo must be greater than or equal to dateFrom',
      );
    }

    const rangeDays = (localToKey - localFromKey) / 86400000;

    if (rangeDays > 366) {
      throw new BadRequestException(
        'Date range cannot exceed 366 days',
      );
    }

    const dateFromUtc = this.localMidnightToUtc(localFrom, timeZone);
    const nextDayAfterToUtc = this.localMidnightToUtc(
      this.nextLocalDate(localTo),
      timeZone,
    );
    const dateToUtc = new Date(nextDayAfterToUtc.getTime() - 1);

    const assetCode = String(filters.assetCode || '').trim();
    const projectId = String(filters.projectId || '').trim();

    let assetId: string | undefined;

    if (assetCode) {
      const asset = await this.prisma.asset.findFirst({
        where: {
          companyId: integration.companyId,
          assetId: assetCode,
          deletedAt: null,
        },
        select: { id: true },
      });

      if (!asset) {
        return this.buildResponse(
          integration,
          company,
          filters,
          localFrom.text,
          localTo.text,
          timeZone,
          dateFromUtc,
          dateToUtc,
          [],
        );
      }

      assetId = asset.id;
    }

    /*
      Keep the same project-resolution rule used by the existing operations
      reporting logic: prefer the immutable operation project snapshot and,
      only for old rows without a snapshot, fall back to the asset's current
      project.
    */
    const projectScopeCondition = projectId
      ? {
          OR: [
            { projectIdAtOperation: projectId },
            {
              projectIdAtOperation: null,
              asset: {
                is: {
                  projectId,
                },
              },
            },
          ],
        }
      : {};

    const operations = await (this.prisma as any).operation.findMany({
      where: {
        companyId: integration.companyId,
        status: 'COMPLETED',
        type: {
          in: ['DIRECT_REFUEL', 'EXTERNAL_DIRECT_REFUEL'],
        },
        occurredAt: {
          gte: dateFromUtc,
          lte: dateToUtc,
        },
        ...(assetId ? { assetId } : {}),
        ...projectScopeCondition,
      },
      select: {
        id: true,
        assetId: true,
        occurredAt: true,
        quantity: true,
        totalCostAtOperation: true,
        projectIdAtOperation: true,
        projectNameAtOperation: true,
        asset: {
          select: {
            id: true,
            assetId: true,
            type: true,
            category: true,
            projectId: true,
            project: {
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
          },
        },
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });

    const grouped = new Map<string, any>();

    for (const operation of operations) {
      const assetCodeValue =
        operation.asset?.assetId ||
        operation.asset?.id ||
        operation.assetId ||
        'UNKNOWN';

      const projectIdValue =
        operation.projectIdAtOperation ||
        operation.asset?.projectId ||
        null;

      const projectNameValue =
        operation.projectNameAtOperation ||
        operation.asset?.project?.name ||
        operation.asset?.project?.code ||
        projectIdValue ||
        null;

      const key = `${assetCodeValue}::${projectIdValue || ''}`;

      if (!grouped.has(key)) {
        grouped.set(key, {
          assetCode: assetCodeValue,
          assetType: operation.asset?.type || null,
          assetCategory: operation.asset?.category || null,
          projectId: projectIdValue,
          projectName: projectNameValue,
          totalQuantity: 0,
          operationCount: 0,
          totalCost: 0,
        });
      }

      const row = grouped.get(key);
      row.totalQuantity += Number(operation.quantity || 0);
      row.operationCount += 1;

      if (integration.costScopeEnabled) {
        row.totalCost += Number(operation.totalCostAtOperation || 0);
      }
    }

    const rows = Array.from(grouped.values())
      .map((row) => {
        const normalized = {
          ...row,
          totalQuantity: Number(row.totalQuantity.toFixed(3)),
        };

        if (integration.costScopeEnabled) {
          return {
            ...normalized,
            totalCost: Number(row.totalCost.toFixed(2)),
          };
        }

        const { totalCost, ...withoutCost } = normalized;
        return withoutCost;
      })
      .sort((a, b) =>
        String(a.assetCode).localeCompare(String(b.assetCode)),
      );

    return this.buildResponse(
      integration,
      company,
      filters,
      localFrom.text,
      localTo.text,
      timeZone,
      dateFromUtc,
      dateToUtc,
      rows,
    );
  }

  async getCurrentStock(integration: IntegrationContext) {
    if (!integration?.companyId) {
      throw new BadRequestException(
        'Integration company context is missing',
      );
    }

    const company = await this.prisma.company.findFirst({
      where: {
        id: integration.companyId,
        deletedAt: null,
      },
      select: {
        id: true,
        code: true,
        name: true,
        timezone: true,
        currency: true,
      },
    });

    if (!company) {
      throw new BadRequestException('Integration company was not found');
    }

    /*
      Inventory ownership rule:
      DISPENSER rows are intentionally excluded because their fuel stock belongs
      to the parent SHARED_TANK. Including both would double-count inventory.
    */
    const stations = await this.prisma.station.findMany({
      where: {
        companyId: integration.companyId,
        deletedAt: null,
        status: 'ACTIVE',
        NOT: {
          structureType: 'DISPENSER',
        },
      },
      select: {
        id: true,
        stationId: true,
        name: true,
        type: true,
        structureType: true,
        capacity: true,
        currentStock: true,
        projectId: true,
        project: {
          select: {
            id: true,
            code: true,
            name: true,
          },
        },
      },
      orderBy: [
        { projectId: 'asc' },
        { stationId: 'asc' },
        { name: 'asc' },
      ],
    });

    const projectMap = new Map<
      string,
      {
        projectId: string | null;
        projectCode: string | null;
        projectName: string | null;
        currentStock: number;
        stationCount: number;
      }
    >();

    const stationRows = stations.map((station) => {
      const currentStock = Number(station.currentStock || 0);
      const capacity =
        station.capacity === null || station.capacity === undefined
          ? null
          : Number(station.capacity);

      const projectKey = station.projectId || '__NO_PROJECT__';

      if (!projectMap.has(projectKey)) {
        projectMap.set(projectKey, {
          projectId: station.projectId || null,
          projectCode: station.project?.code || null,
          projectName:
            station.project?.name ||
            station.project?.code ||
            null,
          currentStock: 0,
          stationCount: 0,
        });
      }

      const projectRow = projectMap.get(projectKey)!;
      projectRow.currentStock += currentStock;
      projectRow.stationCount += 1;

      return {
        stationId: station.id,
        stationCode: station.stationId,
        stationName: station.name,
        stationType: station.type || null,
        structureType: station.structureType || 'STANDALONE',
        projectId: station.projectId || null,
        projectCode: station.project?.code || null,
        projectName:
          station.project?.name ||
          station.project?.code ||
          null,
        capacity,
        currentStock: Number(currentStock.toFixed(3)),
      };
    });

    const projects = Array.from(projectMap.values())
      .map((project) => ({
        ...project,
        currentStock: Number(project.currentStock.toFixed(3)),
      }))
      .sort((a, b) =>
        String(a.projectName || a.projectCode || '').localeCompare(
          String(b.projectName || b.projectCode || ''),
        ),
      );

    const totalCurrentStock = Number(
      stationRows
        .reduce(
          (sum, station) => sum + Number(station.currentStock || 0),
          0,
        )
        .toFixed(3),
    );

    return {
      company: {
        id: company.id,
        code: company.code,
        name: company.name,
        timezone: company.timezone,
        currency: company.currency,
      },
      client: {
        clientId: integration.clientId || null,
        name: integration.clientName || null,
      },
      totals: {
        currentStock: totalCurrentStock,
        inventoryStations: stationRows.length,
        projects: projects.filter(
          (project) => project.projectId !== null,
        ).length,
      },
      projects,
      stations: stationRows,
    };
  }


  private buildResponse(
    integration: IntegrationContext,
    company: {
      id: string;
      code: string;
      name: string;
      timezone: string;
      currency: string;
    },
    filters: SummaryFilters,
    localFrom: string,
    localTo: string,
    timeZone: string,
    dateFromUtc: Date,
    dateToUtc: Date,
    rows: any[],
  ) {
    const totals: any = {
      totalQuantity: Number(
        rows
          .reduce(
            (sum, row) => sum + Number(row.totalQuantity || 0),
            0,
          )
          .toFixed(3),
      ),
      operationCount: rows.reduce(
        (sum, row) => sum + Number(row.operationCount || 0),
        0,
      ),
    };

    if (integration.costScopeEnabled) {
      totals.totalCost = Number(
        rows
          .reduce(
            (sum, row) => sum + Number(row.totalCost || 0),
            0,
          )
          .toFixed(2),
      );
    }

    return {
      company: {
        id: company.id,
        code: company.code,
        name: company.name,
        timezone: timeZone,
        currency: company.currency,
      },
      client: {
        clientId: integration.clientId || null,
        name: integration.clientName || null,
      },
      period: {
        localFrom,
        localTo,
        timezone: timeZone,
        utcFrom: dateFromUtc.toISOString(),
        utcTo: dateToUtc.toISOString(),
      },
      filters: {
        assetCode: String(filters.assetCode || '').trim() || null,
        projectId: String(filters.projectId || '').trim() || null,
      },
      totals,
      data: rows,
    };
  }
}
