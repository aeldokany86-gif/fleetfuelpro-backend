import { Module } from '@nestjs/common';
import { ImportTemplateService } from './import-template.service';
import { ImportUploadService } from './import-upload.service';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { ProjectCreationDomainService } from '../projects/project-creation-domain.service';
import { ProjectImportConfirmationService } from './project-import-confirmation.service';
import { ProjectImportValidationService } from './project-import-validation.service';

@Module({
  controllers: [ImportsController],
  providers: [
    ImportsService,
    ImportTemplateService,
    ImportUploadService,
    ProjectImportValidationService,
    ProjectImportConfirmationService,
    ProjectCreationDomainService,
  ],
  exports: [
    ImportsService,
    ImportTemplateService,
    ImportUploadService,
    ProjectImportValidationService,
    ProjectImportConfirmationService,
  ],
})
export class ImportsModule {}
