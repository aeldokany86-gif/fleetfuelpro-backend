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
    @Query('includeDeleted') includeDeleted?: string,
  ) {
    return this.stationsService.findAll(
      companyId,
      projectId,
      includeDeleted === 'true',
    );
  }

  @Get('transfers/report')
  getTransferReport(
    @Query('companyId') companyId?: string,
    @Query('fromProjectId') fromProjectId?: string,
    @Query('toProjectId') toProjectId?: string,
    @Query('stationId') stationId?: string,
    @Query('status') status?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.stationsService.getTransferReport({
      companyId,
      fromProjectId,
      toProjectId,
      stationId,
      status,
      dateFrom,
      dateTo,
    });
  }

  @Get('transfers/pending')
  pendingTransfers() {
    return this.stationsService.getPendingTransferRequests();
  }

  @Get('actions/requests')
  getActionRequests(
    @Query('userId') userId: string,
    @Query('status') status?: string,
  ) {
    return this.stationsService.getActionRequests(userId, status);
  }

  @Get('stock-movements')
  getAllStockMovements(
    @Query('companyId') companyId?: string,
    @Query('projectId') projectId?: string,
    @Query('stationId') stationId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('movementType') movementType?: string,
    @Query('direction') direction?: string,
  ) {
    return this.stationsService.getAllStockMovements({
      companyId,
      projectId,
      stationId,
      dateFrom,
      dateTo,
      movementType,
      direction,
    });
  }

  @Get('counter-meter-history')
  getCounterMeterHistory(
    @Query('companyId') companyId?: string,
    @Query('projectId') projectId?: string,
    @Query('stationId') stationId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('eventType') eventType?: string,
  ) {
    return this.stationsService.getCounterMeterHistory({
      companyId,
      projectId,
      stationId,
      dateFrom,
      dateTo,
      eventType,
    });
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

  @Post(':id/action-requests')
  createActionRequest(
    @Param('id') id: string,
    @Body()
    body: {
      actionType: string;
      requestedByUserId: string;
      reason: string;
      actualStock?: number;
      newCounter?: number;
      effectiveAt?: string;
      movementAt?: string;
    },
  ) {
    return this.stationsService.createActionRequest(id, body);
  }

  @Patch('action-requests/:id/review')
  reviewActionRequest(
    @Param('id') id: string,
    @Body()
    body: {
      reviewerUserId: string;
      approve: boolean;
      reviewNote?: string;
    },
  ) {
    return this.stationsService.reviewActionRequest(id, body);
  }

  @Post(':id/transfer')
createTransfer(
  @Param('id') id: string,
  @Body()
  body: {
    toProjectId: string;
    requestedByUserId: string;
    effectiveDate?: string;
  },
) {
  return this.stationsService.createTransferRequest(
    id,
    body.toProjectId,
    body.requestedByUserId,
    body.effectiveDate,
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
