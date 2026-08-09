import { Module } from '@nestjs/common';
import { ImportTemplateService } from './import-template.service';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  controllers: [ImportsController],
  providers: [ImportsService, ImportTemplateService],
  exports: [ImportsService, ImportTemplateService],
})
export class ImportsModule {}
