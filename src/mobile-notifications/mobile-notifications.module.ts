import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { MobileNotificationsController } from './mobile-notifications.controller';
import { MobileNotificationsService } from './mobile-notifications.service';

@Module({
  imports: [PrismaModule],
  controllers: [MobileNotificationsController],
  providers: [MobileNotificationsService],
  exports: [MobileNotificationsService],
})
export class MobileNotificationsModule {}
