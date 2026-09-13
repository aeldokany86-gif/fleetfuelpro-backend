import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OperationCorrectionsModule } from '../operation-corrections/operation-corrections.module';
import { MobileNotificationsModule } from '../mobile-notifications/mobile-notifications.module';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { OperationsRealtimeService } from './operations-realtime.service';

@Module({
  imports: [PrismaModule, OperationCorrectionsModule, MobileNotificationsModule],
  controllers: [OperationsController],
  providers: [OperationsService, OperationsRealtimeService],
  exports: [OperationsService, OperationsRealtimeService],
})
export class OperationsModule {}
