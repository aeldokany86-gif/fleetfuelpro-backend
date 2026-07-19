import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
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

  @Get('pending')
  findPending(@Req() req: any) {
    return this.service.findPending(req);
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
