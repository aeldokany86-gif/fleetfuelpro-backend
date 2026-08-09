import {
  Controller,
  Get,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ImportsService } from './imports.service';

@Controller('imports')
@UseGuards(AuthGuard('jwt'))
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @Get('access')
  async getAccess(
    @Request() req,
    @Query('companyId') companyId?: string,
  ) {
    return this.importsService.getAccessContext(
      req.user.userId,
      req.user.roleName,
      req.user.companyId,
      companyId,
    );
  }

  @Get('batches/:id')
  async getBatch(
    @Request() req,
    @Param('id') id: string,
  ) {
    return this.importsService.getBatch(
      id,
      req.user.userId,
      req.user.roleName,
      req.user.companyId,
    );
  }
}
