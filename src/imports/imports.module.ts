import { Module } from '@nestjs/common';
import { ImportTemplateService } from './import-template.service';
import { ImportUploadService } from './import-upload.service';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { ProjectImportValidationService } from './project-import-validation.service';

@Module({
  controllers: [ImportsController],
  providers: [
    ImportsService,
    ImportTemplateService,
    ImportUploadService,
    ProjectImportValidationService,
  ],
  exports: [
    ImportsService,
    ImportTemplateService,
    ImportUploadService,
    ProjectImportValidationService,
  ],
})
export class ImportsModule {}
