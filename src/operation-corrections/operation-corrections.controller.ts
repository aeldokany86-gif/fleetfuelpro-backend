import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { CreateOperationCorrectionDto } from './dto/create-operation-correction.dto';
import { ReviewOperationCorrectionDto } from './dto/review-operation-correction.dto';
import { OperationCorrectionsService } from './operation-corrections.service';

@Controller('operation-corrections')
export class OperationCorrectionsController {
  constructor(private readonly service: OperationCorrectionsService) {}

  @Post()
  create(@Body() dto: CreateOperationCorrectionDto, @Req() req: any) {
    return this.service.create(dto, req);
  }

  @Get('reports/corrections')
  getOperationCorrectionsReport(
    @Req() req: any,
    @Query('companyId') companyId?: string,
    @Query('projectId') projectId?: string,
    @Query('operationNo') operationNo?: string,
    @Query('status') status?: string,
    @Query('requestedByUserId') requestedByUserId?: string,
    @Query('fieldName') fieldName?: string,
    @Query('operationType') operationType?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.service.getOperationCorrectionsReport(
      {
        companyId,
        projectId,
        operationNo,
        status,
        requestedByUserId,
        fieldName,
        operationType,
        dateFrom,
        dateTo,
      },
      req,
    );
  }

  @Get('reports/odometer-history')
  getOdometerCorrectionHistory(
    @Query('companyId') companyId?: string,
    @Query('projectId') projectId?: string,
    @Query('assetId') assetId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.service.getOdometerCorrectionHistoryReport({
      companyId,
      projectId,
      assetId,
      dateFrom,
      dateTo,
    });
  }

  @Get('pending')
  findPending(@Req() req: any) {
    return this.service.findPending(req);
  }

  @Get(':operationId/correction-context')
  getCorrectionContext(
    @Param('operationId') operationId: string,
    @Req() req: any,
  ) {
    return this.service.getCorrectionContext(operationId, req);
  }

  @Get('operation/:operationId')
  findByOperation(@Param('operationId') operationId: string, @Req() req: any) {
    return this.service.findByOperation(operationId, req);
  }

  @Patch(':id/review')
  review(
    @Param('id') correctionId: string,
    @Body() dto: ReviewOperationCorrectionDto,
    @Req() req: any,
  ) {
    return this.service.review(correctionId, dto, req);
  }
}
