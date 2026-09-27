import { Module } from '@nestjs/common';

import { CompanyIntegrationController } from './company-integration.controller';
import { CompanyIntegrationService } from './company-integration.service';

@Module({
  controllers: [CompanyIntegrationController],
  providers: [CompanyIntegrationService],
  exports: [CompanyIntegrationService],
})
export class CompanyIntegrationModule {}
