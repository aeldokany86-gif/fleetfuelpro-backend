import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { UpdateCompanyIntegrationSettingsDto } from './dto/update-company-integration-settings.dto';

const SUPPORTED_WEBHOOK_EVENTS = [
  'operation.completed',
  'operation.corrected',
  'inventory.adjusted',
] as const;

const BOOLEAN_SETTING_FIELDS = [
  'enabled',
  'operationsSummaryEnabled',
  'operationsDetailsEnabled',
  'costDataEnabled',
  'stockReadEnabled',
  'stockMovementsEnabled',
  'webhooksEnabled',
  'externalMappingEnabled',
  'externalMappingManualEnabled',
  'externalMappingImportEnabled',
] as const;

type BooleanSettingField = (typeof BOOLEAN_SETTING_FIELDS)[number];

const DEFAULT_SETTINGS = {
  enabled: false,

  operationsSummaryEnabled: false,
  operationsDetailsEnabled: false,
  costDataEnabled: false,
  stockReadEnabled: false,
  stockMovementsEnabled: false,

  webhooksEnabled: false,

  externalMappingEnabled: false,
  externalMappingManualEnabled: false,
  externalMappingImportEnabled: false,

  clientLimit: 5,
};

@Injectable()
export class CompanyIntegrationService {
  constructor(private readonly prisma: PrismaService) {}

  private async getCompany(companyId: string) {
    if (!companyId) {
      throw new BadRequestException('Company is required');
    }

    const company = await this.prisma.company.findFirst({
      where: {
        id: companyId,
        deletedAt: null,
      },
      select: {
        id: true,
        code: true,
        name: true,
        isActive: true,
      },
    });

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    return company;
  }

  private ensureCustomerCompany(company: {
    id: string;
    code: string;
    name: string;
    isActive: boolean;
  }) {
    if (String(company.code || '').trim().toUpperCase() === 'PLATFORM') {
      throw new BadRequestException(
        'Integration access cannot be configured for the platform company',
      );
    }
  }

  private validateUpdate(dto: UpdateCompanyIntegrationSettingsDto) {
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException(
        'Integration settings payload is required',
      );
    }

    const hasBooleanUpdate = BOOLEAN_SETTING_FIELDS.some(
      (field) => dto[field] !== undefined,
    );

    const hasClientLimitUpdate = dto.clientLimit !== undefined;
    const hasWebhookEventsUpdate = dto.webhookEvents !== undefined;

    if (
      !hasBooleanUpdate &&
      !hasClientLimitUpdate &&
      !hasWebhookEventsUpdate
    ) {
      throw new BadRequestException(
        'At least one integration setting must be provided',
      );
    }

    for (const field of BOOLEAN_SETTING_FIELDS) {
      if (
        dto[field] !== undefined &&
        typeof dto[field] !== 'boolean'
      ) {
        throw new BadRequestException(`${field} must be true or false`);
      }
    }

    if (dto.clientLimit !== undefined) {
      const normalizedClientLimit = Number(dto.clientLimit);

      if (
        !Number.isInteger(normalizedClientLimit) ||
        normalizedClientLimit < 1
      ) {
        throw new BadRequestException(
          'clientLimit must be an integer greater than or equal to 1',
        );
      }
    }

    if (dto.webhookEvents !== undefined) {
      if (!Array.isArray(dto.webhookEvents)) {
        throw new BadRequestException('webhookEvents must be an array');
      }

      const seenEventTypes = new Set<string>();

      for (const item of dto.webhookEvents) {
        if (!item || typeof item !== 'object') {
          throw new BadRequestException(
            'Each webhook event setting must be an object',
          );
        }

        const eventType = String(item.eventType || '').trim();

        if (
          !SUPPORTED_WEBHOOK_EVENTS.includes(
            eventType as (typeof SUPPORTED_WEBHOOK_EVENTS)[number],
          )
        ) {
          throw new BadRequestException(
            `Unsupported webhook event: ${eventType || '(empty)'}`,
          );
        }

        if (seenEventTypes.has(eventType)) {
          throw new BadRequestException(
            `Duplicate webhook event: ${eventType}`,
          );
        }

        seenEventTypes.add(eventType);

        if (typeof item.enabled !== 'boolean') {
          throw new BadRequestException(
            `Webhook event ${eventType} enabled must be true or false`,
          );
        }
      }
    }
  }

  private serializeSettings(
    company: {
      id: string;
      code: string;
      name: string;
      isActive: boolean;
    },
    settings: any | null,
  ) {
    const configuredEvents = new Map<string, boolean>(
      (settings?.webhookEvents || []).map((event: any) => [
        event.eventType,
        Boolean(event.enabled),
      ]),
    );

    return {
      company: {
        id: company.id,
        code: company.code,
        name: company.name,
        isActive: company.isActive,
      },

      configured: Boolean(settings),

      enabled: settings?.enabled ?? DEFAULT_SETTINGS.enabled,

      apiAccess: {
        operationsSummary:
          settings?.operationsSummaryEnabled ??
          DEFAULT_SETTINGS.operationsSummaryEnabled,
        operationsDetails:
          settings?.operationsDetailsEnabled ??
          DEFAULT_SETTINGS.operationsDetailsEnabled,
        costData:
          settings?.costDataEnabled ??
          DEFAULT_SETTINGS.costDataEnabled,
        stockRead:
          settings?.stockReadEnabled ??
          DEFAULT_SETTINGS.stockReadEnabled,
        stockMovements:
          settings?.stockMovementsEnabled ??
          DEFAULT_SETTINGS.stockMovementsEnabled,
      },

      webhooks: {
        enabled:
          settings?.webhooksEnabled ??
          DEFAULT_SETTINGS.webhooksEnabled,
        events: SUPPORTED_WEBHOOK_EVENTS.map((eventType) => ({
          eventType,
          enabled: configuredEvents.get(eventType) ?? false,
        })),
      },

      externalMapping: {
        enabled:
          settings?.externalMappingEnabled ??
          DEFAULT_SETTINGS.externalMappingEnabled,
        manualEnabled:
          settings?.externalMappingManualEnabled ??
          DEFAULT_SETTINGS.externalMappingManualEnabled,
        importEnabled:
          settings?.externalMappingImportEnabled ??
          DEFAULT_SETTINGS.externalMappingImportEnabled,
      },

      clientLimit:
        settings?.clientLimit ?? DEFAULT_SETTINGS.clientLimit,

      createdAt: settings?.createdAt ?? null,
      updatedAt: settings?.updatedAt ?? null,
    };
  }

  async getCompanySettings(companyId: string) {
    const company = await this.getCompany(companyId);

    const settings =
      await this.prisma.companyIntegrationSettings.findUnique({
        where: {
          companyId,
        },
        include: {
          webhookEvents: {
            orderBy: {
              eventType: 'asc',
            },
          },
        },
      });

    return this.serializeSettings(company, settings);
  }

  async getAuthenticatedCompanySettings(companyId: string) {
    return this.getCompanySettings(companyId);
  }

  async updateCompanySettings(
    companyId: string,
    dto: UpdateCompanyIntegrationSettingsDto,
  ) {
    const company = await this.getCompany(companyId);

    this.ensureCustomerCompany(company);
    this.validateUpdate(dto);

    const settingsData: Record<string, any> = {};

    for (const field of BOOLEAN_SETTING_FIELDS) {
      if (dto[field] !== undefined) {
        settingsData[field] = dto[field];
      }
    }

    if (dto.clientLimit !== undefined) {
      settingsData.clientLimit = Number(dto.clientLimit);
    }

    await this.prisma.$transaction(async (tx) => {
      const settings = await tx.companyIntegrationSettings.upsert({
        where: {
          companyId,
        },
        update: settingsData,
        create: {
          companyId,
          ...DEFAULT_SETTINGS,
          ...settingsData,
        },
      });

      if (dto.webhookEvents !== undefined) {
        for (const item of dto.webhookEvents) {
          const eventType = String(item.eventType).trim();

          await tx.companyIntegrationWebhookEvent.upsert({
            where: {
              companyIntegrationSettingsId_eventType: {
                companyIntegrationSettingsId: settings.id,
                eventType,
              },
            },
            update: {
              enabled: item.enabled,
            },
            create: {
              companyIntegrationSettingsId: settings.id,
              eventType,
              enabled: item.enabled,
            },
          });
        }
      }
    });

    return this.getCompanySettings(companyId);
  }
}
