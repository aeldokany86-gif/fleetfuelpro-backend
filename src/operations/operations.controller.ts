import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { CreateOperationDto } from './dto/create-operation.dto';
import { ReviewOperationDto } from './dto/review-operation.dto';
import { OperationsService } from './operations.service';

@Controller('operations')
export class OperationsController {
  constructor(private readonly operationsService: OperationsService) {}

  @Post()
  create(@Body() dto: CreateOperationDto, @Req() req: any) {
    return this.operationsService.create(dto, req);
  }

@Get()
findAll(@Req() req: any) {
  return this.operationsService.findAll(req);
}

@Get('pending-approvals')
findPendingApprovals(@Req() req: any) {
  return this.operationsService.findPendingApprovals(req);
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
