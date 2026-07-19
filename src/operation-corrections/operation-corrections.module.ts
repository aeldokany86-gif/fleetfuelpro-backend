import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OperationCorrectionsController } from './operation-corrections.controller';
import { OperationCorrectionsService } from './operation-corrections.service';

@Module({
  imports: [PrismaModule],
  controllers: [OperationCorrectionsController],
  providers: [OperationCorrectionsService],
  exports: [OperationCorrectionsService],
})
export class OperationCorrectionsModule {}
