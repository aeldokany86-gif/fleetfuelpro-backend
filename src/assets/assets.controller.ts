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

import { AssetsService } from './assets.service';

@Controller('assets')
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Post()
  create(
    @Body()
    body: {
      companyId: string;
      assetId: string;
      type: string;
      category?: string;
      fuelTankCapacity?: number;
      currentOdometer?: number;
      projectId?: string;
      status?: string;
      createdById?: string;
    },
  ) {
    return this.assetsService.create(body);
  }

  @Get()
  findAll(
    @Query('companyId')
    companyId?: string,

    @Query('projectId')
    projectId?: string,
  ) {
    return this.assetsService.findAll(companyId, projectId);
  }

  @Get('transfers/pending')
  pendingTransfers() {
    return this.assetsService.getPendingTransferRequests();
  }

  @Get('transfers/history')
  transferHistory(
    @Query('companyId')
    companyId?: string,
  ) {
    return this.assetsService.getTransferHistory(companyId);
  }

  @Get('reports/odometer-history')
  odometerHistoryReport(
    @Query('companyId')
    companyId?: string,

    @Query('projectId')
    projectId?: string,

    @Query('assetId')
    assetId?: string,

    @Query('dateFrom')
    dateFrom?: string,

    @Query('dateTo')
    dateTo?: string,
  ) {
    return this.assetsService.getOdometerHistoryReport({
      companyId,
      projectId,
      assetId,
      dateFrom,
      dateTo,
    });
  }

  @Get('actions/requests')
  getActionRequests(
    @Query('userId') userId: string,
    @Query('status') status?: string,
  ) {
    return this.assetsService.getActionRequests(userId, status);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.assetsService.findOne(id);
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
    return this.assetsService.reviewActionRequest(id, body);
  }

  @Patch(':id')
  update(
    @Param('id')
    id: string,

    @Body()
    body: {
      assetId?: string;
      type?: string;
      category?: string | null;
      fuelTankCapacity?: number | null;
      status?: string;
      projectId?: never;
      currentOdometer?: never;
    },
  ) {
    return this.assetsService.update(id, body);
  }

  @Post(':id/action-requests')
  createActionRequest(
    @Param('id') id: string,
    @Body()
    body: {
      actionType: string;
      requestedByUserId: string;
      reason: string;
      newOdometer?: number;
      effectiveAt?: string;
    },
  ) {
    return this.assetsService.createActionRequest(id, body);
  }

  @Post(':id/reset-odometer')
  resetOdometer(
    @Param('id')
    id: string,

    @Body()
    body: {
      newOdometer: number;
      reason: string;
      effectiveAt?: string;
      createdByUserId?: string;
    },
  ) {
    return this.assetsService.resetOdometer(id, body);
  }

  @Get(':id/odometer-reset-history')
  getOdometerResetHistory(@Param('id') id: string) {
    return this.assetsService.getOdometerResetHistory(id);
  }

  @Get(':id/assignment-history')
  getAssignmentHistory(@Param('id') id: string) {
    return this.assetsService.getAssignmentHistory(id);
  }

  @Post('transfers/bulk')
  createBulkTransfer(
    @Body()
    body: {
      assetIds: string[];
      toProjectId: string;
      requestedByUserId: string;
      effectiveDate?: string;
    },
  ) {
    return this.assetsService.createBulkTransferRequests(
      body.assetIds,
      body.toProjectId,
      body.requestedByUserId,
      body.effectiveDate,
    );
  }

  @Post(':id/transfer')
  createTransfer(
    @Param('id')
    id: string,

    @Body()
    body: {
      toProjectId: string;
      requestedByUserId: string;
      effectiveDate?: string;
    },
  ) {
    return this.assetsService.createTransferRequest(
      id,
      body.toProjectId,
      body.requestedByUserId,
      body.effectiveDate,
    );
  }

  @Patch('transfers/:id/review')
  reviewTransfer(
    @Param('id')
    id: string,

    @Body()
    body: {
      managerUserId: string;
      approve: boolean;
      rejectionReason?: string;
    },
  ) {
    return this.assetsService.reviewTransfer(
      id,
      body.managerUserId,
      body.approve,
      body.rejectionReason,
    );
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.assetsService.remove(id);
  }
}
