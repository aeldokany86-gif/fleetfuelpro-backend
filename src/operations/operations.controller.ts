import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { CreateOperationDto } from './dto/create-operation.dto';
import { ReviewOperationDto } from './dto/review-operation.dto';
import { OperationsService } from './operations.service';
import { OperationsRealtimeService } from './operations-realtime.service';

@Controller('operations')
export class OperationsController {
  constructor(
    private readonly operationsService: OperationsService,
    private readonly operationsRealtime: OperationsRealtimeService,
  ) {}

  @Post()
  @UseGuards(AuthGuard('jwt'))
  create(@Body() dto: CreateOperationDto, @Req() req: any) {
    return this.operationsService.create(dto, req);
  }

  @Get('mobile-form-context')
  @UseGuards(AuthGuard('jwt'))
  getMobileFormContext(
    @Query('projectId') projectId: string,
    @Req() req: any,
  ) {
    return this.operationsService.getMobileFormContext(projectId, req);
  }

  @Get('events/stream')
  @UseGuards(AuthGuard('jwt'))
  async streamOperationEvents(@Req() req: any, @Res() res: Response) {
    const access = await this.operationsService.getRealtimeAccessContext(req);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    res.write(
      `event: connected\ndata: ${JSON.stringify({
        type: 'connected',
        occurredAt: new Date().toISOString(),
      })}\n\n`,
    );

    const subscription = this.operationsRealtime
      .eventsForCompany(access.companyId)
      .subscribe((event) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 20000);

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      subscription.unsubscribe();
      if (!res.writableEnded) res.end();
    };

    res.once('close', cleanup);
    req.once('aborted', cleanup);
  }

@Get()
findAll(@Req() req: any) {
  return this.operationsService.findAll(req);
}

@Get('pending-approvals')
findPendingApprovals(@Req() req: any) {
  return this.operationsService.findPendingApprovals(req);
}

@Get('report/summary')
summaryReport(
  @Req() req: any,
  @Query('projectId') projectId?: string,
  @Query('assetId') assetId?: string,
  @Query('type') type?: string,
  @Query('status') status?: string,
  @Query('fuelerEmployeeId') fuelerEmployeeId?: string,
  @Query('dateFrom') dateFrom?: string,
  @Query('dateTo') dateTo?: string,
) {
  return this.operationsService.getSummaryReport(req, {
    projectId,
    assetId,
    type,
    status,
    fuelerEmployeeId,
    dateFrom,
    dateTo,
  });
}

  @Patch(':id/review')
  review(
    @Param('id') operationId: string,
    @Body() dto: ReviewOperationDto,
    @Req() req: any,
  ) {
    return this.operationsService.review(operationId, dto, req);
  }
}
