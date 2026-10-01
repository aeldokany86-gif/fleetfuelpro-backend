import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import {
  TelemetryController,
  TelemetryIngestionController,
} from './telemetry.controller';
import { TelemetryDeviceService } from './telemetry-device.service';
import { TelemetryIngestionService } from './telemetry-ingestion.service';
import { MqttTelemetrySubscriberService } from './mqtt/mqtt-telemetry-subscriber.service';

@Module({
  imports: [PrismaModule],
  controllers: [TelemetryController, TelemetryIngestionController],
  providers: [
    TelemetryDeviceService,
    TelemetryIngestionService,
    MqttTelemetrySubscriberService,
  ],
  exports: [TelemetryDeviceService, TelemetryIngestionService],
})
export class TelemetryModule {}