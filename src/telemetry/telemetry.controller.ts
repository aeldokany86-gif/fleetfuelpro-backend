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

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.telemetryDeviceService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body()
    body: {
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
