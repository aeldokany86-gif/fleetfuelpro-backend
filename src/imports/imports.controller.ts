import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ImportTemplateService } from './import-template.service';
import { ImportUploadService } from './import-upload.service';
import { ImportsService } from './imports.service';
import { ProjectImportConfirmationService } from './project-import-confirmation.service';
import { ProjectImportValidationService } from './project-import-validation.service';

const MAX_IMPORT_FILE_SIZE = 5 * 1024 * 1024;

@Controller('imports')
@UseGuards(AuthGuard('jwt'))
export class ImportsController {
  constructor(
    private readonly importsService: ImportsService,
    private readonly importTemplateService: ImportTemplateService,
    private readonly importUploadService: ImportUploadService,
    private readonly projectImportValidationService: ProjectImportValidationService,
    private readonly projectImportConfirmationService: ProjectImportConfirmationService,
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

  @Post('projects/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: MAX_IMPORT_FILE_SIZE,
      },
    }),
  )
  async uploadProjectsImport(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
    @Query('companyId') companyId?: string,
  ) {
    return this.importUploadService.uploadProjectsTemplate({
      file,
      actorUserId: req.user.userId,
      actorRoleName: req.user.roleName,
      actorCompanyId: req.user.companyId,
      targetCompanyId: companyId,
    });
  }

  @Post('batches/:id/validate')
  async validateBatch(
    @Request() req,
    @Param('id') id: string,
  ) {
    return this.projectImportValidationService.validateProjectsBatch({
      batchId: id,
      actorUserId: req.user.userId,
      actorRoleName: req.user.roleName,
      actorCompanyId: req.user.companyId,
    });
  }

  @Post('batches/:id/confirm')
  async confirmBatch(
    @Request() req,
    @Param('id') id: string,
  ) {
    return this.projectImportConfirmationService.confirmProjectsBatch({
      batchId: id,
      actorUserId: req.user.userId,
      actorRoleName: req.user.roleName,
      actorCompanyId: req.user.companyId,
    });
  }

  @Get('batches/:id/preview')
  async getBatchPreview(
    @Request() req,
    @Param('id') id: string,
  ) {
    return this.projectImportValidationService.getProjectsPreview({
      batchId: id,
      actorUserId: req.user.userId,
      actorRoleName: req.user.roleName,
      actorCompanyId: req.user.companyId,
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
