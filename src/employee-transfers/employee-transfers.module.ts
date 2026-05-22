import { Module } from '@nestjs/common';
import { EmployeeTransfersController } from './employee-transfers.controller';
import { EmployeeTransfersService } from './employee-transfers.service';

@Module({
  controllers: [EmployeeTransfersController],
  providers: [EmployeeTransfersService]
})
export class EmployeeTransfersModule {}
