import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { AssetCreationDomainService } from './asset-creation-domain.service';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [AssetsController],
  providers: [AssetsService, AssetCreationDomainService],
  exports: [AssetsService, AssetCreationDomainService],
})
export class AssetsModule {}
