import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'crypto';

import { PrismaService } from '../prisma/prisma.service';
import { INTEGRATION_SCOPE_METADATA_KEY } from './integration-scope.decorator';

const SCOPE_ENTITLEMENT_FIELD: Record<string, string> = {
  'operations.summary': 'operationsSummaryEnabled',
  'operations.details': 'operationsDetailsEnabled',
  'cost.read': 'costDataEnabled',
  'stock.read': 'stockReadEnabled',
  'stock.movements.read': 'stockMovementsEnabled',
};

@Injectable()
export class IntegrationApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  private getHeader(req: any, name: string) {
    const value = req?.headers?.[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  private getBearerApiKey(req: any) {
    const authorization = String(
      this.getHeader(req, 'authorization') || '',
    ).trim();

    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return match ? String(match[1] || '').trim() : '';
  }

  private hashApiKey(apiKey: string) {
    return createHash('sha256').update(apiKey).digest('hex');
  }

  private safeHashEquals(leftHex: string, rightHex: string) {
    try {
      const left = Buffer.from(leftHex, 'hex');
      const right = Buffer.from(rightHex, 'hex');

      if (!left.length || left.length !== right.length) return false;
      return timingSafeEqual(left, right);
    } catch {
      return false;
    }
  }

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();

    const clientId = String(
      this.getHeader(req, 'x-ffp-client-id') || '',
    ).trim();
    const apiKey = this.getBearerApiKey(req);

    if (!clientId || !apiKey) {
      throw new UnauthorizedException(
        'Integration credentials are required',
      );
    }

    const client = await this.prisma.integrationClient.findUnique({
      where: { clientId },
      include: {
        company: {
          select: {
            id: true,
            code: true,
            name: true,
            isActive: true,
            deletedAt: true,
          },
        },
        scopes: {
          where: { enabled: true },
          select: { scope: true },
        },
      },
    });

    if (!client || !client.company || client.company.deletedAt) {
      throw new UnauthorizedException('Invalid integration credentials');
    }

    if (client.status !== 'ACTIVE' || !client.company.isActive) {
      throw new UnauthorizedException('Integration Client is disabled');
    }

    const suppliedHash = this.hashApiKey(apiKey);

    if (!this.safeHashEquals(suppliedHash, client.apiKeyHash)) {
      throw new UnauthorizedException('Invalid integration credentials');
    }

    const settings =
      await this.prisma.companyIntegrationSettings.findUnique({
        where: { companyId: client.companyId },
      });

    if (!settings?.enabled) {
      throw new ForbiddenException(
        'API Integration is disabled for this company',
      );
    }

    const requiredScope =
      this.reflector.getAllAndOverride<string>(
        INTEGRATION_SCOPE_METADATA_KEY,
        [context.getHandler(), context.getClass()],
      ) || '';

    const clientScopes = new Set(
      (client.scopes || []).map((item) => item.scope),
    );

    if (requiredScope) {
      if (!clientScopes.has(requiredScope)) {
        throw new ForbiddenException(
          `Integration Client does not have scope ${requiredScope}`,
        );
      }

      const entitlementField = SCOPE_ENTITLEMENT_FIELD[requiredScope];

      if (
        entitlementField &&
        !Boolean((settings as any)[entitlementField])
      ) {
        throw new ForbiddenException(
          `Scope ${requiredScope} is not enabled for this company`,
        );
      }
    }

    const costScopeEnabled =
      clientScopes.has('cost.read') &&
      Boolean(settings.costDataEnabled);

    req.integration = {
      clientInternalId: client.id,
      clientId: client.clientId,
      clientName: client.name,
      companyId: client.companyId,
      companyCode: client.company.code,
      companyName: client.company.name,
      scopes: Array.from(clientScopes),
      costScopeEnabled,
    };

    await this.prisma.integrationClient.update({
      where: { id: client.id },
      data: { lastUsedAt: new Date() },
    });

    return true;
  }
}
