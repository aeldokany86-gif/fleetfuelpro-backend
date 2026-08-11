import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { StationsController } from './stations.controller';
import { StationsService } from './stations.service';
import { StationCreationDomainService } from './station-creation-domain.service';

@Module({
  imports: [PrismaModule],
  controllers: [StationsController],
  providers: [StationsService, StationCreationDomainService],
  exports: [StationsService, StationCreationDomainService],
})
export class StationsModule {}
