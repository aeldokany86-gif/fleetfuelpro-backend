import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import {
  TelemetryController,
  TelemetryIngestionController,
  TelemetrySensorController,
} from './telemetry.controller';
import { TelemetryDeviceService } from './telemetry-device.service';
import { TelemetryIngestionService } from './telemetry-ingestion.service';
import { TelemetrySensorService } from './telemetry-sensor.service';
import { MqttTelemetrySubscriberService } from './mqtt/mqtt-telemetry-subscriber.service';
import { TelemetryAdapterRegistry } from './adapters/telemetry-adapter.registry';
import { XirgoIotmAdapter } from './adapters/xirgo/xirgo-iotm.adapter';
import { TeltonikaCodec8ExtendedAdapter } from './adapters/teltonika/teltonika-codec8e.adapter';
import { TeltonikaTcpServerService } from './tcp/teltonika-tcp-server.service';

@Module({
  imports: [PrismaModule],
  controllers: [TelemetryController, TelemetrySensorController, TelemetryIngestionController],
  providers: [
    TelemetryDeviceService,
    TelemetryIngestionService,
    TelemetrySensorService,
    XirgoIotmAdapter,
    TeltonikaCodec8ExtendedAdapter,
    TelemetryAdapterRegistry,
    MqttTelemetrySubscriberService,
    TeltonikaTcpServerService,
  ],
  exports: [TelemetryDeviceService, TelemetryIngestionService],
})
export class TelemetryModule {}