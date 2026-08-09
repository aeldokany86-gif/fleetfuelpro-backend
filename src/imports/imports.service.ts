import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ImportsService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeRoleName(roleName: string) {
    return String(roleName || '')
      .trim()
      .toUpperCase()
      .replace(/[\s_-]+/g, '');
  }

  async resolveImportContext(
    actorUserId: string,
    actorRoleName: string,
    actorCompanyId: string,
    targetCompanyId?: string,
  ) {
    if (!actorUserId) {
      throw new BadRequestException('Authenticated user is required');
    }

    const actor = await this.prisma.user.findFirst({
      where: {
        id: actorUserId,
        isActive: true,
        deletedAt: null,
      },
      include: {
        role: true,
      },
    });

    if (!actor) {
      throw new BadRequestException(
        'Authenticated user not found or inactive',
      );
    }

    const jwtRole = this.normalizeRoleName(actorRoleName);
    const databaseRole = this.normalizeRoleName(actor.role?.name || '');

    if (jwtRole !== databaseRole) {
      throw new BadRequestException(
        'Authenticated user role is not valid',
      );
    }

    const isPlatformUser = databaseRole === 'PLATFORMUSER';
    const isCompanyAdmin = databaseRole === 'ADMIN';

    if (!isPlatformUser && !isCompanyAdmin) {
      throw new BadRequestException(
        'Data Import Center is available only to Platform User or an enabled company Admin',
      );
    }

    let companyId: string;

    if (isPlatformUser) {
      companyId = String(targetCompanyId || '').trim();

      if (!companyId) {
        throw new BadRequestException('Target company is required');
      }
    } else {
      companyId = String(actorCompanyId || actor.companyId || '').trim();

      if (!companyId || actor.companyId !== companyId) {
        throw new BadRequestException(
          'Authenticated company is not valid',
        );
      }

      if (
        targetCompanyId &&
        String(targetCompanyId).trim() !== companyId
      ) {
        throw new BadRequestException(
          'Company Admin can import data only for their own company',
        );
      }
    }

    const company = await this.prisma.company.findFirst({
      where: {
        id: companyId,
        isActive: true,
        deletedAt: null,
      },
    });

    if (!company) {
      throw new BadRequestException(
        'Target company not found or inactive',
      );
    }

    if (isCompanyAdmin && !company.dataImportEnabled) {
      throw new BadRequestException(
        'Data Import Center is not enabled for this company',
      );
    }

    return {
      actor,
      company,
      companyId: company.id,
      accessMode: isPlatformUser ? 'PLATFORM' : 'COMPANY_ADMIN',
    };
  }

  async getAccessContext(
    actorUserId: string,
    actorRoleName: string,
    actorCompanyId: string,
    targetCompanyId?: string,
  ) {
    const context = await this.resolveImportContext(
      actorUserId,
      actorRoleName,
      actorCompanyId,
      targetCompanyId,
    );

    return {
      allowed: true,
      accessMode: context.accessMode,
      company: {
        id: context.company.id,
        code: context.company.code,
        name: context.company.name,
        country: context.company.country,
        currency: context.company.currency,
        language: context.company.language,
        dataImportEnabled: context.company.dataImportEnabled,
      },
    };
  }

  async getBatch(
    batchId: string,
    actorUserId: string,
    actorRoleName: string,
    actorCompanyId: string,
  ) {
    const batch = await this.prisma.importBatch.findFirst({
      where: {
        id: batchId,
      },
      include: {
        company: {
          select: {
            id: true,
            code: true,
            name: true,
            dataImportEnabled: true,
          },
        },
        uploadedBy: {
          select: {
            id: true,
            fullName: true,
            username: true,
          },
        },
        confirmedBy: {
          select: {
            id: true,
            fullName: true,
            username: true,
          },
        },
      },
    });

    if (!batch) {
      throw new NotFoundException('Import batch not found');
    }

    await this.resolveImportContext(
      actorUserId,
      actorRoleName,
      actorCompanyId,
      batch.companyId,
    );

    return batch;
  }
}
