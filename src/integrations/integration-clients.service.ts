import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';

import { PrismaService } from '../prisma/prisma.service';
import {
  CreateIntegrationClientDto,
  UpdateIntegrationClientDto,
} from './dto/integration-client.dto';

const SUPPORTED_SCOPES = [
  'operations.summary',
  'operations.details',
  'cost.read',
  'stock.read',
  'stock.movements.read',
] as const;

type SupportedScope = (typeof SUPPORTED_SCOPES)[number];

const SCOPE_ENTITLEMENT_FIELD: Record<SupportedScope, string> = {
  'operations.summary': 'operationsSummaryEnabled',
  'operations.details': 'operationsDetailsEnabled',
  'cost.read': 'costDataEnabled',
  'stock.read': 'stockReadEnabled',
  'stock.movements.read': 'stockMovementsEnabled',
};

@Injectable()
export class IntegrationClientsService {
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

    if (String(company.code || '').trim().toUpperCase() === 'PLATFORM') {
      throw new BadRequestException(
        'Integration clients cannot be created for the platform company',
      );
    }

    if (!company.isActive) {
      throw new BadRequestException('Company is inactive');
    }

    return company;
  }

  private async getSettings(companyId: string) {
    const settings =
      await this.prisma.companyIntegrationSettings.findUnique({
        where: { companyId },
      });

    if (!settings || !settings.enabled) {
      throw new BadRequestException(
        'API Integration is not enabled for this company',
      );
    }

    return settings;
  }

  private normalizeName(value: unknown) {
    const name = String(value ?? '').trim().replace(/\s+/g, ' ');

    if (!name) {
      throw new BadRequestException('Integration client name is required');
    }

    if (name.length > 120) {
      throw new BadRequestException(
        'Integration client name cannot exceed 120 characters',
      );
    }

    return name;
  }

  private normalizeScopes(scopes: unknown): SupportedScope[] {
    if (scopes === undefined) return [];

    if (!Array.isArray(scopes)) {
      throw new BadRequestException('scopes must be an array');
    }

    const normalized = Array.from(
      new Set(
        scopes.map((scope) => String(scope || '').trim()).filter(Boolean),
      ),
    );

    for (const scope of normalized) {
      if (!SUPPORTED_SCOPES.includes(scope as SupportedScope)) {
        throw new BadRequestException(`Unsupported integration scope: ${scope}`);
      }
    }

    return normalized as SupportedScope[];
  }

  private ensureScopesAllowed(
    settings: Record<string, any>,
    scopes: SupportedScope[],
  ) {
    for (const scope of scopes) {
      const entitlementField = SCOPE_ENTITLEMENT_FIELD[scope];

      if (!Boolean(settings[entitlementField])) {
        throw new BadRequestException(
          `Scope ${scope} is not enabled for this company`,
        );
      }
    }
  }

  private generateClientId() {
    return `ffp_client_${randomBytes(12).toString('hex')}`;
  }

  private generateApiKey() {
    return `ffp_live_${randomBytes(32).toString('base64url')}`;
  }

  private hashApiKey(apiKey: string) {
    return createHash('sha256').update(apiKey).digest('hex');
  }

  private buildKeyPrefix(apiKey: string) {
    const visibleLength = Math.min(18, apiKey.length);
    return `${apiKey.slice(0, visibleLength)}••••`;
  }

  private serializeClient(client: any) {
    return {
      id: client.id,
      companyId: client.companyId,
      name: client.name,
      status: client.status,
      clientId: client.clientId,
      keyPrefix: client.keyPrefix,
      scopes: (client.scopes || [])
        .filter((item: any) => item.enabled !== false)
        .map((item: any) => item.scope),
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
      lastUsedAt: client.lastUsedAt,
    };
  }

  async listCompanyClients(companyId: string) {
    await this.getCompany(companyId);
    const settings = await this.getSettings(companyId);

    const [clients, totalClients] = await Promise.all([
      this.prisma.integrationClient.findMany({
        where: { companyId },
        include: {
          scopes: {
            orderBy: { scope: 'asc' },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.integrationClient.count({
        where: { companyId },
      }),
    ]);

    return {
      companyId,
      clientLimit: settings.clientLimit,
      usedClients: totalClients,
      remainingClients: Math.max(settings.clientLimit - totalClients, 0),
      clients: clients.map((client) => this.serializeClient(client)),
    };
  }

  async listAuthenticatedCompanyClients(companyId: string) {
    return this.listCompanyClients(companyId);
  }

  async createClient(
    companyId: string,
    dto: CreateIntegrationClientDto,
  ) {
    await this.getCompany(companyId);
    const settings = await this.getSettings(companyId);

    const name = this.normalizeName(dto?.name);
    const scopes = this.normalizeScopes(dto?.scopes);

    this.ensureScopesAllowed(settings as any, scopes);

    return this.prisma.$transaction(async (tx) => {
      const existingCount = await tx.integrationClient.count({
        where: { companyId },
      });

      if (existingCount >= settings.clientLimit) {
        throw new ConflictException(
          `Integration client limit reached (${settings.clientLimit})`,
        );
      }

      const existingName = await tx.integrationClient.findFirst({
        where: {
          companyId,
          name,
        },
        select: { id: true },
      });

      if (existingName) {
        throw new ConflictException(
          'An Integration Client with this name already exists',
        );
      }

      let clientId = this.generateClientId();

      while (
        await tx.integrationClient.findUnique({
          where: { clientId },
          select: { id: true },
        })
      ) {
        clientId = this.generateClientId();
      }

      const apiKey = this.generateApiKey();
      const apiKeyHash = this.hashApiKey(apiKey);
      const keyPrefix = this.buildKeyPrefix(apiKey);

      const created = await tx.integrationClient.create({
        data: {
          companyId,
          name,
          clientId,
          apiKeyHash,
          keyPrefix,
          status: 'ACTIVE',
          scopes: {
            create: scopes.map((scope) => ({
              scope,
              enabled: true,
            })),
          },
        },
        include: {
          scopes: {
            orderBy: { scope: 'asc' },
          },
        },
      });

      return {
        ...this.serializeClient(created),
        apiKey,
        apiKeyNotice:
          'Save this API key now. For security, Fleet Fuel PRO will not show the full key again.',
      };
    });
  }

  async updateClient(
    companyId: string,
    integrationClientId: string,
    dto: UpdateIntegrationClientDto,
  ) {
    await this.getCompany(companyId);
    const settings = await this.getSettings(companyId);

    const current = await this.prisma.integrationClient.findFirst({
      where: {
        id: integrationClientId,
        companyId,
      },
      include: {
        scopes: true,
      },
    });

    if (!current) {
      throw new NotFoundException('Integration Client not found');
    }

    const hasNameUpdate = dto?.name !== undefined;
    const hasScopesUpdate = dto?.scopes !== undefined;

    if (!hasNameUpdate && !hasScopesUpdate) {
      throw new BadRequestException(
        'At least one Integration Client field must be provided',
      );
    }

    const name = hasNameUpdate
      ? this.normalizeName(dto.name)
      : current.name;

    const scopes = hasScopesUpdate
      ? this.normalizeScopes(dto.scopes)
      : current.scopes
          .filter((item) => item.enabled !== false)
          .map((item) => item.scope as SupportedScope);

    this.ensureScopesAllowed(settings as any, scopes);

    const duplicateName = await this.prisma.integrationClient.findFirst({
      where: {
        companyId,
        name,
        NOT: { id: current.id },
      },
      select: { id: true },
    });

    if (duplicateName) {
      throw new ConflictException(
        'An Integration Client with this name already exists',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.integrationClient.update({
        where: { id: current.id },
        data: { name },
      });

      if (hasScopesUpdate) {
        await tx.integrationClientScope.deleteMany({
          where: { integrationClientId: current.id },
        });

        if (scopes.length) {
          await tx.integrationClientScope.createMany({
            data: scopes.map((scope) => ({
              integrationClientId: current.id,
              scope,
              enabled: true,
            })),
            skipDuplicates: true,
          });
        }
      }

      const updated = await tx.integrationClient.findUnique({
        where: { id: current.id },
        include: {
          scopes: {
            orderBy: { scope: 'asc' },
          },
        },
      });

      return this.serializeClient(updated);
    });
  }

  async updateClientStatus(
    companyId: string,
    integrationClientId: string,
    enabled: boolean,
  ) {
    await this.getCompany(companyId);
    await this.getSettings(companyId);

    if (typeof enabled !== 'boolean') {
      throw new BadRequestException('enabled must be true or false');
    }

    const current = await this.prisma.integrationClient.findFirst({
      where: {
        id: integrationClientId,
        companyId,
      },
      select: { id: true },
    });

    if (!current) {
      throw new NotFoundException('Integration Client not found');
    }

    const updated = await this.prisma.integrationClient.update({
      where: { id: current.id },
      data: {
        status: enabled ? 'ACTIVE' : 'DISABLED',
      },
      include: {
        scopes: {
          orderBy: { scope: 'asc' },
        },
      },
    });

    return this.serializeClient(updated);
  }

  async rotateApiKey(
    companyId: string,
    integrationClientId: string,
  ) {
    await this.getCompany(companyId);
    await this.getSettings(companyId);

    const current = await this.prisma.integrationClient.findFirst({
      where: {
        id: integrationClientId,
        companyId,
      },
      select: { id: true },
    });

    if (!current) {
      throw new NotFoundException('Integration Client not found');
    }

    const apiKey = this.generateApiKey();

    const updated = await this.prisma.integrationClient.update({
      where: { id: current.id },
      data: {
        apiKeyHash: this.hashApiKey(apiKey),
        keyPrefix: this.buildKeyPrefix(apiKey),
      },
      include: {
        scopes: {
          orderBy: { scope: 'asc' },
        },
      },
    });

    return {
      ...this.serializeClient(updated),
      apiKey,
      apiKeyNotice:
        'Save this API key now. The previous key is no longer valid and the new full key will not be shown again.',
    };
  }
}
