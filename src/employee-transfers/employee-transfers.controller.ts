import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { EmployeeTransfersService } from './employee-transfers.service';

@Controller('employee-transfers')
export class EmployeeTransfersController {
  constructor(
    private readonly service: EmployeeTransfersService,
  ) {}

  @Post()
  create(
    @Body()
    body: {
      employeeId: string;
      toProjectId: string;
      requestedByUserId: string;
      effectiveDate?: string;
    },
  ) {
    return this.service.createTransferRequest(
      body.employeeId,
      body.toProjectId,
      body.requestedByUserId,
      body.effectiveDate,
    );
  }

  @Post('bulk')
  createBulk(
    @Body()
    body: {
      employeeIds: string[];
      toProjectId: string;
      requestedByUserId: string;
    },
  ) {
    return this.service.createBulkTransferRequests(
      body.employeeIds,
      body.toProjectId,
      body.requestedByUserId,
    );
  }

  @Get('pending')
  pending() {
    return this.service.getPendingRequests();
  }

  @Get('report')
  report(
    @Query('companyId') companyId: string,
    @Query('employeeId') employeeId?: string,
    @Query('fromProjectId') fromProjectId?: string,
    @Query('toProjectId') toProjectId?: string,
    @Query('status') status?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.service.getTransferReport({
      companyId,
      employeeId,
      fromProjectId,
      toProjectId,
      status,
      dateFrom,
      dateTo,
    });
  }

  @Patch(':id/review')
  review(
    @Param('id')
    id: string,

    @Body()
    body: {
      managerUserId: string;
      approve: boolean;
      rejectionReason?: string;
    },
  ) {
    return this.service.reviewTransfer(
      id,
      body.managerUserId,
      body.approve,
      body.rejectionReason,
    );
  }
}
