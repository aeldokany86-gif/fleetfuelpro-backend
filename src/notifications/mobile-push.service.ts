import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  getMobilePushTestMessage,
  normalizeNotificationLanguage,
} from './notification-messages';

type JwtRequestUser = {
  userId?: string;
  companyId?: string;
  roleId?: string;
  roleName?: string;
};

type RegisterDeviceInput = {
  installationId?: string;
  expoPushToken?: string;
  platform?: string;
  deviceName?: string;
  appVersion?: string;
};

type UnregisterDeviceInput = {
  installationId?: string;
};

export type PushMessage = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
};

type ExpoPushResponseItem = {
  status?: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: {
    error?: string;
  };
};

@Injectable()
export class MobilePushService {
  private readonly expoPushUrl = 'https://exp.host/--/api/v2/push/send';

  constructor(private readonly prisma: PrismaService) {}

  private async resolveCurrentUser(jwtUser?: JwtRequestUser) {
    const userId = String(jwtUser?.userId || '').trim();
    const companyId = String(jwtUser?.companyId || '').trim();

    if (!userId || !companyId) {
      throw new BadRequestException('Authenticated user context is required.');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        companyId,
        deletedAt: null,
        isActive: true,
      },
      select: {
        id: true,
        companyId: true,
        preferredLanguage: true,
      },
    });

    if (!user) {
      throw new NotFoundException('Active authenticated user was not found.');
    }

    return user;
  }

  private normalizeExpoPushToken(value?: string) {
    const token = String(value || '').trim();

    if (!token) {
      throw new BadRequestException('Expo push token is required.');
    }

    if (!/^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(token)) {
      throw new BadRequestException('Invalid Expo push token format.');
    }

    return token;
  }

  private normalizeInstallationId(value?: string) {
    const installationId = String(value || '').trim();

    if (
      !installationId ||
      installationId.length < 12 ||
      installationId.length > 200
    ) {
      throw new BadRequestException(
        'A valid mobile installation ID is required.',
      );
    }

    return installationId;
  }

  private normalizePlatform(value?: string) {
    const platform = String(value || '').trim().toLowerCase();

    if (!['android', 'ios'].includes(platform)) {
      throw new BadRequestException(
        'Mobile platform must be android or ios.',
      );
    }

    return platform;
  }

  async registerDevice(input: RegisterDeviceInput, jwtUser?: JwtRequestUser) {
    const user = await this.resolveCurrentUser(jwtUser);
    const installationId = this.normalizeInstallationId(input.installationId);
    const expoPushToken = this.normalizeExpoPushToken(input.expoPushToken);
    const platform = this.normalizePlatform(input.platform);
    const deviceName =
      String(input.deviceName || '').trim().slice(0, 200) || null;
    const appVersion =
      String(input.appVersion || '').trim().slice(0, 50) || null;

    const registration = await this.prisma.$transaction(async (tx) => {
      await tx.mobilePushToken.deleteMany({
        where: {
          expoPushToken,
          installationId: { not: installationId },
        },
      });

      return tx.mobilePushToken.upsert({
        where: { installationId },
        create: {
          userId: user.id,
          companyId: user.companyId,
          installationId,
          expoPushToken,
          platform,
          deviceName,
          appVersion,
          isActive: true,
          lastRegisteredAt: new Date(),
          lastError: null,
        },
        update: {
          userId: user.id,
          companyId: user.companyId,
          expoPushToken,
          platform,
          deviceName,
          appVersion,
          isActive: true,
          lastRegisteredAt: new Date(),
          lastError: null,
        },
        select: {
          id: true,
          platform: true,
          deviceName: true,
          appVersion: true,
          isActive: true,
          lastRegisteredAt: true,
        },
      });
    });

    return {
      ok: true,
      registration,
    };
  }

  async unregisterDevice(input: UnregisterDeviceInput, jwtUser?: JwtRequestUser) {
    const user = await this.resolveCurrentUser(jwtUser);
    const installationId = this.normalizeInstallationId(input.installationId);

    await this.prisma.mobilePushToken.updateMany({
      where: {
        installationId,
        userId: user.id,
        companyId: user.companyId,
      },
      data: {
        isActive: false,
      },
    });

    return { ok: true };
  }

  async sendTestPush(jwtUser?: JwtRequestUser) {
    const user = await this.resolveCurrentUser(jwtUser);
    const language = normalizeNotificationLanguage(user.preferredLanguage);
    const message = getMobilePushTestMessage(language);

    const result = await this.sendToUser(user.id, {
      title: message.title,
      body: message.body,
      data: {
        type: 'TEST_NOTIFICATION',
        screen: 'notifications',
      },
      sound: 'default',
    });

    return {
      ok: true,
      ...result,
    };
  }

  async sendToUser(userId: string, message: PushMessage) {
    const registrations = await this.prisma.mobilePushToken.findMany({
      where: {
        userId,
        isActive: true,
        user: {
          isActive: true,
          deletedAt: null,
        },
      },
      select: {
        id: true,
        expoPushToken: true,
      },
    });

    if (registrations.length === 0) {
      return {
        registeredDevices: 0,
        accepted: 0,
        failed: 0,
      };
    }

    const payload = registrations.map((registration) => ({
      to: registration.expoPushToken,
      title: message.title,
      body: message.body,
      sound: message.sound === undefined ? 'default' : message.sound,
      data: message.data || {},
    }));

    let response: Response;

    try {
      response = await fetch(this.expoPushUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new BadRequestException(
        `Expo push service could not be reached: ${
          error instanceof Error ? error.message : 'Unknown network error'
        }`,
      );
    }

    let responseBody: { data?: ExpoPushResponseItem[] } | null = null;

    try {
      responseBody = (await response.json()) as {
        data?: ExpoPushResponseItem[];
      };
    } catch {
      responseBody = null;
    }

    if (!response.ok) {
      throw new BadRequestException(
        `Expo push service rejected the request with HTTP ${response.status}.`,
      );
    }

    const tickets = Array.isArray(responseBody?.data) ? responseBody.data : [];
    let accepted = 0;
    let failed = 0;
    const now = new Date();

    for (let index = 0; index < registrations.length; index += 1) {
      const registration = registrations[index];
      const ticket = tickets[index];

      if (ticket?.status === 'ok') {
        accepted += 1;
        await this.prisma.mobilePushToken.update({
          where: { id: registration.id },
          data: {
            lastDeliveryAt: now,
            lastError: null,
          },
        });
        continue;
      }

      failed += 1;
      const expoError = String(
        ticket?.details?.error ||
          ticket?.message ||
          'UNKNOWN_EXPO_PUSH_ERROR',
      );
      const deviceNotRegistered = expoError === 'DeviceNotRegistered';

      await this.prisma.mobilePushToken.update({
        where: { id: registration.id },
        data: {
          isActive: deviceNotRegistered ? false : undefined,
          lastError: expoError,
        },
      });
    }

    return {
      registeredDevices: registrations.length,
      accepted,
      failed,
    };
  }
}
