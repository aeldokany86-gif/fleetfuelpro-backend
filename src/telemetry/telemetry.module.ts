import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { TelemetryController } from './telemetry.controller';
import { TelemetryDeviceService } from './telemetry-device.service';

@Module({
  imports: [PrismaModule],
  controllers: [TelemetryController],
  providers: [TelemetryDeviceService],
  exports: [TelemetryDeviceService],
})
export class TelemetryModule {}
