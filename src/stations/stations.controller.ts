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

import { StationsService } from './stations.service';

@Controller('stations')
export class StationsController {
  constructor(private readonly stationsService: StationsService) {}

  @Post()
  create(
    @Body()
    body: {
      companyId: string;
      stationId: string;
      name?: string;
      type?: string;
      capacity?: number;
      openingBalance?: number;
      currentCounter?: number;
      projectId?: string;
      status?: string;
      createdById?: string;
    },
  ) {
    return this.stationsService.create(body);
  }

  @Get()
  findAll(
    @Query('companyId') companyId?: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.stationsService.findAll(companyId, projectId);
  }

  @Get('transfers/pending')
  pendingTransfers() {
    return this.stationsService.getPendingTransferRequests();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.stationsService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body()
    body: {
      stationId?: string;
      name?: string | null;
      type?: string | null;
      capacity?: number | null;
      status?: string;
      projectId?: never;
      currentStock?: never;
      openingBalance?: never;
      currentCounter?: never;
    },
  ) {
    return this.stationsService.update(id, body);
  }

  @Post(':id/reset-counter')
  resetCounter(
    @Param('id') id: string,
    @Body()
    body: {
      newCounter: number;
      reason: string;
      effectiveAt?: string;
      createdByUserId?: string;
    },
  ) {
    return this.stationsService.resetCounter(id, body);
  }

  @Get(':id/counter-reset-history')
  getCounterResetHistory(@Param('id') id: string) {
    return this.stationsService.getCounterResetHistory(id);
  }

  @Get(':id/assignment-history')
  getAssignmentHistory(@Param('id') id: string) {
    return this.stationsService.getAssignmentHistory(id);
  }

  @Get(':id/stock-movements')
  getStockMovements(@Param('id') id: string) {
    return this.stationsService.getStockMovements(id);
  }

  @Post(':id/adjust-inventory')
  adjustInventory(
    @Param('id') id: string,
    @Body()
    body: {
      actualStock: number;
      reason: string;
      movementAt?: string;
      createdByUserId?: string;
    },
  ) {
    return this.stationsService.adjustInventory(id, body);
  }

  @Post(':id/zero-balance')
  zeroBalance(
    @Param('id') id: string,
    @Body()
    body: {
      reason: string;
      movementAt?: string;
      createdByUserId?: string;
    },
  ) {
    return this.stationsService.zeroBalance(id, body);
  }

  @Post(':id/transfer')
  createTransfer(
    @Param('id') id: string,
    @Body()
    body: {
      toProjectId: string;
      requestedByUserId: string;
    },
  ) {
    return this.stationsService.createTransferRequest(
      id,
      body.toProjectId,
      body.requestedByUserId,
    );
  }

  @Patch('transfers/:id/review')
  reviewTransfer(
    @Param('id') id: string,
    @Body()
    body: {
      managerUserId: string;
      approve: boolean;
      rejectionReason?: string;
    },
  ) {
    return this.stationsService.reviewTransfer(
      id,
      body.managerUserId,
      body.approve,
      body.rejectionReason,
    );
  }

  @Delete('hard/:id')
  hardDelete(@Param('id') id: string) {
    return this.stationsService.hardDelete(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.stationsService.remove(id);
  }
}
