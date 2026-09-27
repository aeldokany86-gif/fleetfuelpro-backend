import { Module } from '@nestjs/common';

import { CompanyIntegrationController } from './company-integration.controller';
import { CompanyIntegrationService } from './company-integration.service';

import { IntegrationClientsController } from './integration-clients.controller';
import { IntegrationClientsService } from './integration-clients.service';

@Module({
  controllers: [
    CompanyIntegrationController,
    IntegrationClientsController,
  ],
  providers: [
    CompanyIntegrationService,
    IntegrationClientsService,
  ],
  exports: [
    CompanyIntegrationService,
    IntegrationClientsService,
  ],
})
export class CompanyIntegrationModule {}
