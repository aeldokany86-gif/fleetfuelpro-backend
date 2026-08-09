import {
  Controller,
  Get,
  Param,
  Query,
  Request,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ImportTemplateService } from './import-template.service';
import { ImportsService } from './imports.service';

@Controller('imports')
@UseGuards(AuthGuard('jwt'))
export class ImportsController {
  constructor(
    private readonly importsService: ImportsService,
    private readonly importTemplateService: ImportTemplateService,
  ) {}

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

  @Get('templates/projects')
  async downloadProjectsTemplate(
    @Request() req,
    @Query('language') language = 'en',
    @Query('companyId') companyId?: string,
  ) {
    await this.importsService.resolveImportContext(
      req.user.userId,
      req.user.roleName,
      req.user.companyId,
      companyId,
    );

    const template =
      await this.importTemplateService.buildProjectsTemplate(language);

    return new StreamableFile(template.buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${template.fileName}"`,
    });
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
