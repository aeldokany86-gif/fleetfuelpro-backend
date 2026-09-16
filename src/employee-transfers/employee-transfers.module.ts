import { Module } from '@nestjs/common';
import { EmployeeTransfersController } from './employee-transfers.controller';
import { EmployeeTransfersService } from './employee-transfers.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [EmployeeTransfersController],
  providers: [EmployeeTransfersService]
})
export class EmployeeTransfersModule {}
