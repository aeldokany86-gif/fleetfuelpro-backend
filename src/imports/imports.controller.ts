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
import { EmployeeImportValidationService } from './employee-import-validation.service';
import { EmployeeImportConfirmationService } from './employee-import-confirmation.service';
import { StationImportValidationService } from './station-import-validation.service';
import { StationImportConfirmationService } from './station-import-confirmation.service';
import { AssetImportValidationService } from './asset-import-validation.service';
import { AssetImportConfirmationService } from './asset-import-confirmation.service';

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
    private readonly employeeImportValidationService: EmployeeImportValidationService,
    private readonly employeeImportConfirmationService: EmployeeImportConfirmationService,
    private readonly stationImportValidationService: StationImportValidationService,
    private readonly stationImportConfirmationService: StationImportConfirmationService,
    private readonly assetImportValidationService: AssetImportValidationService,
    private readonly assetImportConfirmationService: AssetImportConfirmationService,
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


  @Get('templates/employees')
  async downloadEmployeesTemplate(
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
      await this.importTemplateService.buildEmployeesTemplate(language);

    return new StreamableFile(template.buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${template.fileName}"`,
    });
  }

  @Post('employees/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_IMPORT_FILE_SIZE },
    }),
  )
  async uploadEmployeesImport(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
    @Query('companyId') companyId?: string,
  ) {
    return this.importUploadService.uploadEmployeesTemplate({
      file,
      actorUserId: req.user.userId,
      actorRoleName: req.user.roleName,
      actorCompanyId: req.user.companyId,
      targetCompanyId: companyId,
    });
  }


  @Get('templates/stations')
  async downloadStationsTemplate(
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
      await this.importTemplateService.buildStationsTemplate(language);

    return new StreamableFile(template.buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${template.fileName}"`,
    });
  }

  @Post('stations/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_IMPORT_FILE_SIZE },
    }),
  )
  async uploadStationsImport(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
    @Query('companyId') companyId?: string,
  ) {
    return this.importUploadService.uploadStationsTemplate({
      file,
      actorUserId: req.user.userId,
      actorRoleName: req.user.roleName,
      actorCompanyId: req.user.companyId,
      targetCompanyId: companyId,
    });
  }


  @Get('templates/assets')
  async downloadAssetsTemplate(
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
      await this.importTemplateService.buildAssetsTemplate(language);

    return new StreamableFile(template.buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${template.fileName}"`,
    });
  }

  @Post('assets/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_IMPORT_FILE_SIZE },
    }),
  )
  async uploadAssetsImport(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
    @Query('companyId') companyId?: string,
  ) {
    return this.importUploadService.uploadAssetsTemplate({
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
    const batch = await this.importsService.getBatch(
      id,
      req.user.userId,
      req.user.roleName,
      req.user.companyId,
    );

    const input = {
      batchId: id,
      actorUserId: req.user.userId,
      actorRoleName: req.user.roleName,
      actorCompanyId: req.user.companyId,
    };

    if (batch.importType === 'EMPLOYEES') {
      return this.employeeImportValidationService.validateEmployeesBatch(input);
    }

    if (batch.importType === 'STATIONS') {
      return this.stationImportValidationService.validateStationsBatch(input);
    }

    if (batch.importType === 'ASSETS') {
      return this.assetImportValidationService.validateAssetsBatch(input);
    }

    return this.projectImportValidationService.validateProjectsBatch(input);
  }

  @Post('batches/:id/confirm')
  async confirmBatch(
    @Request() req,
    @Param('id') id: string,
  ) {
    const batch = await this.importsService.getBatch(
      id,
      req.user.userId,
      req.user.roleName,
      req.user.companyId,
    );

    const input = {
      batchId: id,
      actorUserId: req.user.userId,
      actorRoleName: req.user.roleName,
      actorCompanyId: req.user.companyId,
    };

    if (batch.importType === 'EMPLOYEES') {
      return this.employeeImportConfirmationService.confirmEmployeesBatch(input);
    }

    if (batch.importType === 'STATIONS') {
      return this.stationImportConfirmationService.confirmStationsBatch(input);
    }

    if (batch.importType === 'ASSETS') {
      return this.assetImportConfirmationService.confirmAssetsBatch(input);
    }

    return this.projectImportConfirmationService.confirmProjectsBatch(input);
  }

  @Get('batches/:id/preview')
  async getBatchPreview(
    @Request() req,
    @Param('id') id: string,
  ) {
    const batch = await this.importsService.getBatch(
      id,
      req.user.userId,
      req.user.roleName,
      req.user.companyId,
    );

    const input = {
      batchId: id,
      actorUserId: req.user.userId,
      actorRoleName: req.user.roleName,
      actorCompanyId: req.user.companyId,
    };

    if (batch.importType === 'EMPLOYEES') {
      return this.employeeImportValidationService.getEmployeesPreview(input);
    }

    if (batch.importType === 'STATIONS') {
      return this.stationImportValidationService.getStationsPreview(input);
    }

    if (batch.importType === 'ASSETS') {
      return this.assetImportValidationService.getAssetsPreview(input);
    }

    return this.projectImportValidationService.getProjectsPreview(input);
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
