import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { extname } from 'path';
import { PrismaService } from '../prisma/prisma.service';

type OperationPhotoOwnerType =
  | 'station'
  | 'asset'
  | 'supplier'
  | 'miscellaneous';

type AuthenticatedUploadUser = {
  id: string;
  companyId: string;
};

@Injectable()
export class UploadsService {
  private readonly supabase: SupabaseClient;
  private readonly bucket: string;

  constructor(private readonly prisma: PrismaService) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    this.bucket = process.env.SUPABASE_STORAGE_BUCKET || 'fleetfuelpro';

    if (!supabaseUrl || !serviceRoleKey) {
      throw new InternalServerErrorException(
        'Supabase Storage environment variables are missing.',
      );
    }

    this.supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  async uploadOperationPhoto(args: {
    file: Express.Multer.File;
    authenticatedUserId: string;
    operationNo: string;
    ownerType: string;
    ownerCode: string;
    photoType: string;
  }) {
    const {
      file,
      authenticatedUserId,
      operationNo,
      ownerType,
      ownerCode,
      photoType,
    } = args;

    const authenticatedUser =
      await this.resolveAuthenticatedUploadUser(authenticatedUserId);

    if (!file) {
      throw new BadRequestException('Photo file is required.');
    }

    if (!operationNo) {
      throw new BadRequestException('operationNo is required.');
    }

    if (!ownerType) {
      throw new BadRequestException('ownerType is required.');
    }

    if (!ownerCode) {
      throw new BadRequestException('ownerCode is required.');
    }

    if (!photoType) {
      throw new BadRequestException('photoType is required.');
    }

    if (!String(file.mimetype || '').startsWith('image/')) {
      throw new BadRequestException('Only image files are allowed.');
    }

    const maxSizeBytes = 8 * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      throw new BadRequestException('Photo size must not exceed 8 MB.');
    }

    const safeCompanyId = this.safePathSegment(authenticatedUser.companyId);
    const normalizedOwnerType = this.normalizeOwnerType(ownerType);
    const ownerFolder = this.getOwnerFolder(normalizedOwnerType);
    const safeOwnerCode = this.safePathSegment(ownerCode).toUpperCase();
    const safeOperationNo = this.safePathSegment(operationNo).toUpperCase();
    const safePhotoType = this.safePathSegment(photoType).toLowerCase();
    const extension = this.getSafeExtension(file.originalname, file.mimetype);

    const fileName = `${safeOperationNo}_${safePhotoType}${extension}`;
    const path = `operations/${safeCompanyId}/${ownerFolder}/${safeOwnerCode}/${fileName}`;

    const { data, error } = await this.supabase.storage
      .from(this.bucket)
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return {
      ok: true,
      bucket: this.bucket,
      path: data?.path || path,
      fileName,
      companyId: safeCompanyId,
      ownerType: normalizedOwnerType,
      ownerFolder,
      ownerCode: safeOwnerCode,
      operationNo: safeOperationNo,
      photoType: safePhotoType,
      mimeType: file.mimetype,
      size: file.size,
    };
  }

  async createSignedUrl(args: {
    authenticatedUserId: string;
    path: string;
    expiresIn?: number;
  }) {
    const { authenticatedUserId, path, expiresIn = 300 } = args;

    const authenticatedUser =
      await this.resolveAuthenticatedUploadUser(authenticatedUserId);

    if (!path) {
      throw new BadRequestException('path is required.');
    }

    const safeCompanyId = this.safePathSegment(authenticatedUser.companyId);
    const normalizedPath = String(path).trim().replace(/^\/+/, '');
    const allowedPrefix = `operations/${safeCompanyId}/`;

    if (!normalizedPath.startsWith(allowedPrefix)) {
      throw new UnauthorizedException(
        'Requested photo does not belong to the authenticated company.',
      );
    }

    const safeExpiresIn = Math.min(
      Math.max(Number(expiresIn) || 300, 60),
      3600,
    );

    const { data, error } = await this.supabase.storage
      .from(this.bucket)
      .createSignedUrl(normalizedPath, safeExpiresIn);

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return {
      ok: true,
      path: normalizedPath,
      expiresIn: safeExpiresIn,
      signedUrl: data.signedUrl,
    };
  }

  private async resolveAuthenticatedUploadUser(
    userId: string,
  ): Promise<AuthenticatedUploadUser> {
    const normalizedUserId = String(userId || '').trim();

    if (!normalizedUserId) {
      throw new UnauthorizedException(
        'Authenticated user identity was not found.',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: normalizedUserId },
      select: {
        id: true,
        companyId: true,
        isActive: true,
        deletedAt: true,
      },
    });

    if (!user || user.deletedAt || user.isActive === false) {
      throw new UnauthorizedException(
        'Authenticated user account is not available.',
      );
    }

    if (!user.companyId) {
      throw new UnauthorizedException(
        'Authenticated user is not assigned to a company.',
      );
    }

    return {
      id: user.id,
      companyId: user.companyId,
    };
  }

  private normalizeOwnerType(value: string): OperationPhotoOwnerType {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '-');

    if (['station', 'stations'].includes(normalized)) return 'station';
    if (['asset', 'assets', 'equipment', 'equipments'].includes(normalized))
      return 'asset';
    if (
      ['supplier', 'suppliers', 'external', 'external-supplier'].includes(
        normalized,
      )
    )
      return 'supplier';
    if (['misc', 'miscellaneous', 'other'].includes(normalized))
      return 'miscellaneous';

    throw new BadRequestException(
      'ownerType must be station, asset, supplier, or miscellaneous.',
    );
  }

  private getOwnerFolder(ownerType: OperationPhotoOwnerType) {
    if (ownerType === 'station') return 'stations';
    if (ownerType === 'asset') return 'assets';
    if (ownerType === 'supplier') return 'suppliers';
    return 'miscellaneous';
  }

  private safePathSegment(value: string) {
    const cleaned = String(value || '')
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!cleaned) {
      throw new BadRequestException('Invalid path segment.');
    }

    return cleaned;
  }

  private getSafeExtension(originalName = '', mimeType = '') {
    const byName = extname(originalName).toLowerCase();

    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    if (allowed.includes(byName)) return byName;

    const mime = String(mimeType || '').toLowerCase();
    if (mime === 'image/jpeg') return '.jpg';
    if (mime === 'image/png') return '.png';
    if (mime === 'image/webp') return '.webp';
    if (mime === 'image/gif') return '.gif';

    return '.jpg';
  }
}
