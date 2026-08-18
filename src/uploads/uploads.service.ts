import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { PrismaService } from '../prisma/prisma.service';

type OperationPhotoOwnerType =
  | 'station'
  | 'asset'
  | 'supplier'
  | 'miscellaneous';

type OperationPhotoCaptureSource = 'WEB' | 'CAMERA' | 'GALLERY';

type AuthenticatedUploadUser = {
  id: string;
  companyId: string;
};

@Injectable()
export class UploadsService implements OnModuleInit, OnModuleDestroy {
  private readonly supabase: SupabaseClient;
  private readonly bucket: string;
  private readonly draftTtlHours: number;
  private readonly cleanupIntervalMinutes: number;
  private readonly cleanupBatchSize: number;
  private cleanupTimer?: NodeJS.Timeout;
  private startupCleanupTimer?: NodeJS.Timeout;
  private cleanupRunning = false;

  constructor(private readonly prisma: PrismaService) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    this.bucket = process.env.SUPABASE_STORAGE_BUCKET || 'fleetfuelpro';
    this.draftTtlHours = this.readBoundedNumber(
      process.env.OPERATION_PHOTO_DRAFT_TTL_HOURS,
      24,
      1,
      720,
    );
    this.cleanupIntervalMinutes = this.readBoundedNumber(
      process.env.OPERATION_PHOTO_DRAFT_CLEANUP_INTERVAL_MINUTES,
      60,
      10,
      1440,
    );
    this.cleanupBatchSize = this.readBoundedNumber(
      process.env.OPERATION_PHOTO_DRAFT_CLEANUP_BATCH_SIZE,
      100,
      1,
      500,
    );

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


  onModuleInit() {
    // Give the app time to finish startup before the first orphan cleanup pass.
    this.startupCleanupTimer = setTimeout(() => {
      void this.cleanupStaleOperationPhotoDrafts();
    }, 60_000);
    this.startupCleanupTimer.unref?.();

    this.cleanupTimer = setInterval(() => {
      void this.cleanupStaleOperationPhotoDrafts();
    }, this.cleanupIntervalMinutes * 60_000);
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.startupCleanupTimer) clearTimeout(this.startupCleanupTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  async uploadOperationPhoto(args: {
    file: Express.Multer.File;
    authenticatedUserId: string;
    ownerType: string;
    ownerCode: string;
    photoType: string;
    captureSource?: string;
  }) {
    const {
      file,
      authenticatedUserId,
      ownerType,
      ownerCode,
      photoType,
      captureSource = 'WEB',
    } = args;

    const authenticatedUser =
      await this.resolveAuthenticatedUploadUser(authenticatedUserId);

    if (!file) {
      throw new BadRequestException('Photo file is required.');
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
    const safePhotoType = this.safePathSegment(photoType).toLowerCase();
    const normalizedCaptureSource = this.normalizeCaptureSource(captureSource);
    const extension = this.getSafeExtension(file.originalname, file.mimetype);

    const draftId = randomUUID();
    const timestamp = this.buildStorageTimestamp(new Date());
    const uniqueSuffix = draftId.replace(/-/g, '').slice(0, 8);
    const fileName = `${timestamp}_${uniqueSuffix}_${safePhotoType}${extension}`;
    const path = `operations/${safeCompanyId}/${ownerFolder}/${safeOwnerCode}/${fileName}`;

    const { data, error } = await this.supabase.storage
      .from(this.bucket)
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const storedPath = data?.path || path;

    try {
      const draft = await (this.prisma as any).operationPhotoDraft.create({
        data: {
          id: draftId,
          companyId: authenticatedUser.companyId,
          uploadedByUserId: authenticatedUser.id,
          status: 'PENDING',
          bucket: this.bucket,
          path: storedPath,
          fileName,
          photoType: safePhotoType,
          ownerType: normalizedOwnerType,
          ownerCode: safeOwnerCode,
          captureSource: normalizedCaptureSource,
          mimeType: file.mimetype,
          sizeBytes: file.size,
        },
      });

      return {
        ok: true,
        draftId: draft.id,
        draftStatus: draft.status,
        bucket: this.bucket,
        path: storedPath,
        fileName,
        companyId: safeCompanyId,
        ownerType: normalizedOwnerType,
        ownerFolder,
        ownerCode: safeOwnerCode,
        photoType: safePhotoType,
        captureSource: normalizedCaptureSource,
        mimeType: file.mimetype,
        size: file.size,
      };
    } catch (dbError: any) {
      // Storage succeeded but DB registration failed. Remove this exact object so
      // the new draft system does not create an orphan before it can be tracked.
      await this.supabase.storage
        .from(this.bucket)
        .remove([storedPath])
        .catch(() => undefined);

      throw new InternalServerErrorException(
        dbError?.message || 'Failed to register uploaded photo draft.',
      );
    }
  }


  async deletePendingOperationPhotoDraft(args: {
    authenticatedUserId: string;
    draftId: string;
  }) {
    const authenticatedUser = await this.resolveAuthenticatedUploadUser(
      args.authenticatedUserId,
    );
    const draftId = String(args.draftId || '').trim();

    if (!draftId) {
      throw new BadRequestException('draftId is required.');
    }

    const draft = await (this.prisma as any).operationPhotoDraft.findUnique({
      where: { id: draftId },
    });

    if (!draft || draft.companyId !== authenticatedUser.companyId) {
      throw new NotFoundException('Photo draft was not found.');
    }

    if (draft.uploadedByUserId !== authenticatedUser.id) {
      throw new ForbiddenException(
        'Photo draft belongs to another authenticated user.',
      );
    }

    if (draft.status !== 'PENDING' || draft.operationId) {
      throw new BadRequestException(
        'Only an unused PENDING photo draft can be deleted.',
      );
    }

    const deleted = await this.deletePendingDraftObjectAndRecord(draft);

    if (!deleted) {
      throw new BadRequestException(
        'Photo draft changed before it could be deleted.',
      );
    }

    return {
      ok: true,
      deleted: true,
      draftId: draft.id,
      path: draft.path,
    };
  }

  async cleanupStaleOperationPhotoDrafts() {
    if (this.cleanupRunning) return;

    this.cleanupRunning = true;
    const startedAt = Date.now();
    const cutoff = new Date(
      Date.now() - this.draftTtlHours * 60 * 60 * 1000,
    );

    let deletedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    try {
      const drafts = await (this.prisma as any).operationPhotoDraft.findMany({
        where: {
          status: 'PENDING',
          operationId: null,
          createdAt: { lt: cutoff },
        },
        orderBy: { createdAt: 'asc' },
        take: this.cleanupBatchSize,
      });

      for (const draft of drafts) {
        try {
          const deleted = await this.deletePendingDraftObjectAndRecord(draft);
          if (deleted) deletedCount += 1;
          else skippedCount += 1;
        } catch (error: any) {
          failedCount += 1;
          console.error(
            '[OPERATION_PHOTO_DRAFT_CLEANUP_ITEM_FAILED]',
            JSON.stringify({
              draftId: draft.id,
              path: draft.path,
              error: error?.message || String(error),
            }),
          );
        }
      }

      if (drafts.length || failedCount) {
        console.log(
          '[OPERATION_PHOTO_DRAFT_CLEANUP]',
          JSON.stringify({
            cutoff: cutoff.toISOString(),
            ttlHours: this.draftTtlHours,
            scanned: drafts.length,
            deleted: deletedCount,
            skipped: skippedCount,
            failed: failedCount,
            batchSize: this.cleanupBatchSize,
            durationMs: Date.now() - startedAt,
          }),
        );
      }
    } catch (error: any) {
      console.error(
        '[OPERATION_PHOTO_DRAFT_CLEANUP_FAILED]',
        JSON.stringify({
          cutoff: cutoff.toISOString(),
          error: error?.message || String(error),
          durationMs: Date.now() - startedAt,
        }),
      );
    } finally {
      this.cleanupRunning = false;
    }
  }

  private async deletePendingDraftObjectAndRecord(draft: any) {
    /*
     * Claim the draft by deleting its PENDING DB row first. This makes cleanup
     * race-safe with operation creation: Phase 4's guarded updateMany will fail
     * and roll the operation back if the draft was claimed for deletion first.
     * If Storage removal fails, recreate the exact tracking row so the object
     * remains visible to a later cleanup pass instead of becoming untracked.
     */
    const claimed = await (this.prisma as any).operationPhotoDraft.deleteMany({
      where: {
        id: draft.id,
        companyId: draft.companyId,
        uploadedByUserId: draft.uploadedByUserId,
        status: 'PENDING',
        operationId: null,
      },
    });

    if (claimed.count !== 1) return false;

    const { error } = await this.supabase.storage
      .from(draft.bucket || this.bucket)
      .remove([draft.path]);

    if (!error) return true;

    try {
      await (this.prisma as any).operationPhotoDraft.create({
        data: {
          id: draft.id,
          companyId: draft.companyId,
          uploadedByUserId: draft.uploadedByUserId,
          operationId: null,
          status: 'PENDING',
          bucket: draft.bucket,
          path: draft.path,
          fileName: draft.fileName,
          photoType: draft.photoType,
          ownerType: draft.ownerType,
          ownerCode: draft.ownerCode,
          captureSource: draft.captureSource,
          mimeType: draft.mimeType,
          sizeBytes: draft.sizeBytes,
          createdAt: draft.createdAt,
          consumedAt: null,
        },
      });
    } catch (restoreError: any) {
      console.error(
        '[OPERATION_PHOTO_DRAFT_RESTORE_FAILED]',
        JSON.stringify({
          draftId: draft.id,
          path: draft.path,
          storageError: error.message,
          restoreError: restoreError?.message || String(restoreError),
        }),
      );
    }

    throw new InternalServerErrorException(
      `Failed to remove photo draft from Storage: ${error.message}`,
    );
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

    /*
     * New draft-backed photos get user-level protection while PENDING.
     * Existing legacy photos have no OperationPhotoDraft row, so they keep the
     * Phase 2 company-level signed URL behavior and remain backward compatible.
     */
    const draft = await (this.prisma as any).operationPhotoDraft.findUnique({
      where: { path: normalizedPath },
      select: {
        uploadedByUserId: true,
        companyId: true,
        status: true,
      },
    });

    if (draft) {
      if (draft.companyId !== authenticatedUser.companyId) {
        throw new UnauthorizedException(
          'Requested photo does not belong to the authenticated company.',
        );
      }

      if (
        draft.status === 'PENDING' &&
        draft.uploadedByUserId !== authenticatedUser.id
      ) {
        throw new UnauthorizedException(
          'Pending photo draft belongs to another user.',
        );
      }
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

  private normalizeCaptureSource(value: string): OperationPhotoCaptureSource {
    const normalized = String(value || 'WEB').trim().toUpperCase();

    if (['WEB', 'CAMERA', 'GALLERY'].includes(normalized)) {
      return normalized as OperationPhotoCaptureSource;
    }

    throw new BadRequestException(
      'captureSource must be WEB, CAMERA, or GALLERY.',
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

  private buildStorageTimestamp(value: Date) {
    const pad = (number: number) => String(number).padStart(2, '0');

    return [
      value.getUTCFullYear(),
      pad(value.getUTCMonth() + 1),
      pad(value.getUTCDate()),
      '_',
      pad(value.getUTCHours()),
      pad(value.getUTCMinutes()),
      pad(value.getUTCSeconds()),
      pad(Math.floor(value.getUTCMilliseconds() / 10)),
    ].join('');
  }


  private readBoundedNumber(
    rawValue: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
  ) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.floor(parsed), minimum), maximum);
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
