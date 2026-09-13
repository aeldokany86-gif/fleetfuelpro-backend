import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { MobilePushController } from './mobile-push.controller';
import { MobilePushService } from './mobile-push.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [PrismaModule],
  controllers: [NotificationsController, MobilePushController],
  providers: [NotificationsService, MobilePushService],
  exports: [NotificationsService, MobilePushService],
})
export class NotificationsModule {}
