import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  Prisma,
  TelemetryDeviceStatus,
  TelemetryTransport,
} from '@prisma/client';

import { TelemetryDeviceService } from './telemetry-device.service';
import { TelemetryIngestionService } from './telemetry-ingestion.service';

@Controller('telemetry/devices')
export class TelemetryController {
  constructor(
    private readonly telemetryDeviceService: TelemetryDeviceService,
  ) {}

  @Post()
  create(
    @Body()
    body: {
      companyId: string;
      assetId?: string | null;
      vendor: string;
      model?: string | null;
      hardwareId: string;
      protocol?: string | null;
      transport?: TelemetryTransport | null;
      status?: TelemetryDeviceStatus;
      firmwareVersion?: string | null;
      metadata?: Prisma.InputJsonValue | null;
    },
  ) {
    return this.telemetryDeviceService.create(body);
  }

  @Get()
  findAll(
    @Query('companyId') companyId?: string,
    @Query('assetId') assetId?: string,
    @Query('vendor') vendor?: string,
    @Query('status') status?: TelemetryDeviceStatus,
  ) {
    return this.telemetryDeviceService.findAll({
      companyId,
      assetId,
      vendor,
      status,
    });
  }

  @Get(':id/latest')
  getLatestTelemetry(@Param('id') id: string) {
    return this.telemetryDeviceService.getLatestTelemetry(id);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.telemetryDeviceService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body()
    body: {
      hardwareId?: string;
      model?: string | null;
      protocol?: string | null;
      transport?: TelemetryTransport | null;
      status?: TelemetryDeviceStatus;
      firmwareVersion?: string | null;
      metadata?: Prisma.InputJsonValue | null;
    },
  ) {
    return this.telemetryDeviceService.update(id, body);
  }

  @Post(':id/assign')
  assignToAsset(
    @Param('id') id: string,
    @Body()
    body: {
      companyId: string;
      assetId: string;
    },
  ) {
    return this.telemetryDeviceService.assignToAsset(id, body);
  }

  @Post(':id/unassign')
  unassignFromAsset(
    @Param('id') id: string,
    @Body()
    body: {
      companyId: string;
    },
  ) {
    return this.telemetryDeviceService.unassignFromAsset(id, body);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    return this.telemetryDeviceService.remove(id, companyId);
  }
}

@Controller('telemetry')
export class TelemetryIngestionController {
  constructor(
    private readonly telemetryIngestionService: TelemetryIngestionService,
  ) {}

  @Post('raw')
  ingestRaw(
    @Body()
    body: {
      companyId: string;
      deviceId?: string | null;
      transport: TelemetryTransport;
      topic?: string | null;
      payload: string;
      payloadEncoding?: 'utf8' | 'base64' | 'hex';
      protocolVersion?: string | null;
      checksumValid?: boolean | null;
      readingAt?: string | null;
      metadata?: Prisma.InputJsonValue | null;
    },
  ) {
    return this.telemetryIngestionService.ingestRaw(body);
  }

  @Post('xirgo')
  ingestXirgo(
    @Body()
    body: {
      companyId: string;
      deviceId: string;
      transport: TelemetryTransport;
      topic?: string | null;
      payload: string;
      payloadEncoding?: 'base64' | 'hex';
      metadata?: Prisma.InputJsonValue | null;
    },
  ) {
    return this.telemetryIngestionService.ingestXirgo(body);
  }
}
