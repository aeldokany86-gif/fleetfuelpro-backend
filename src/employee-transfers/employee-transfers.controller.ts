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
      keepLinkedProjects?: boolean;
    },
  ) {
    return this.service.createTransferRequest(
      body.employeeId,
      body.toProjectId,
      body.requestedByUserId,
      body.effectiveDate,
      null,
      body.keepLinkedProjects ?? true,
    );
  }

  @Post('bulk')
  createBulk(
    @Body()
    body: {
      employeeIds: string[];
      toProjectId: string;
      requestedByUserId: string;
      keepLinkedProjects?: boolean;
    },
  ) {
    return this.service.createBulkTransferRequests(
      body.employeeIds,
      body.toProjectId,
      body.requestedByUserId,
      body.keepLinkedProjects ?? true,
    );
  }


  @Get('project-removal-requests/pending')
  pendingProjectRemovalRequests(
    @Query('approverUserId') approverUserId: string,
  ) {
    return this.service.getPendingProjectRemovalRequests(approverUserId);
  }

  @Patch('project-removal-requests/:id/review')
  reviewProjectRemovalRequest(
    @Param('id') id: string,
    @Body()
    body: {
      reviewerUserId: string;
      approve: boolean;
      rejectionReason?: string;
    },
  ) {
    return this.service.reviewProjectRemovalRequest(
      id,
      body.reviewerUserId,
      body.approve,
      body.rejectionReason,
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
