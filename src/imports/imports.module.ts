import { Module } from '@nestjs/common';
import { ImportTemplateService } from './import-template.service';
import { ImportUploadService } from './import-upload.service';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { ProjectCreationDomainService } from '../projects/project-creation-domain.service';
import { ProjectImportConfirmationService } from './project-import-confirmation.service';
import { ProjectImportValidationService } from './project-import-validation.service';
import { EmployeeCreationDomainService } from '../employees/employee-creation-domain.service';
import { EmployeeImportValidationService } from './employee-import-validation.service';
import { EmployeeImportConfirmationService } from './employee-import-confirmation.service';
import { StationCreationDomainService } from '../stations/station-creation-domain.service';
import { StationImportValidationService } from './station-import-validation.service';
import { StationImportConfirmationService } from './station-import-confirmation.service';
import { AssetCreationDomainService } from '../assets/asset-creation-domain.service';
import { AssetImportValidationService } from './asset-import-validation.service';
import { AssetImportConfirmationService } from './asset-import-confirmation.service';

@Module({
  controllers: [ImportsController],
  providers: [
    ImportsService,
    ImportTemplateService,
    ImportUploadService,
    ProjectImportValidationService,
    ProjectImportConfirmationService,
    ProjectCreationDomainService,
    EmployeeCreationDomainService,
    EmployeeImportValidationService,
    EmployeeImportConfirmationService,
    StationCreationDomainService,
    StationImportValidationService,
    StationImportConfirmationService,
    AssetCreationDomainService,
    AssetImportValidationService,
    AssetImportConfirmationService,
  ],
  exports: [
    ImportsService,
    ImportTemplateService,
    ImportUploadService,
    ProjectImportValidationService,
    ProjectImportConfirmationService,
    EmployeeImportValidationService,
    EmployeeImportConfirmationService,
    StationImportValidationService,
    StationImportConfirmationService,
    AssetImportValidationService,
    AssetImportConfirmationService,
  ],
})
export class ImportsModule {}
