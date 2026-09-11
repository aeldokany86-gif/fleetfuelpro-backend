import { Module } from '@nestjs/common';

import { AssetsModule } from '../assets/assets.module';
import { EmployeeTransfersModule } from '../employee-transfers/employee-transfers.module';
import { OperationCorrectionsModule } from '../operation-corrections/operation-corrections.module';
import { OperationsModule } from '../operations/operations.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StationsModule } from '../stations/stations.module';
import { MobileApprovalsController } from './mobile-approvals.controller';
import { MobileApprovalsService } from './mobile-approvals.service';

@Module({
  imports: [
    PrismaModule,
    OperationsModule,
    OperationCorrectionsModule,
    AssetsModule,
    StationsModule,
    EmployeeTransfersModule,
  ],
  controllers: [MobileApprovalsController],
  providers: [MobileApprovalsService],
})
export class MobileApprovalsModule {}
