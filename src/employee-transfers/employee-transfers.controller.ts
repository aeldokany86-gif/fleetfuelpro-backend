import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
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

  @Get('pending')
  pending() {
    return this.service.getPendingRequests();
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
