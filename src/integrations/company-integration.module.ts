import { Module } from '@nestjs/common';

import { CompanyIntegrationController } from './company-integration.controller';
import { CompanyIntegrationService } from './company-integration.service';

import { IntegrationClientsController } from './integration-clients.controller';
import { IntegrationClientsService } from './integration-clients.service';

import { ExternalIntegrationController } from './external-integration.controller';
import { ExternalIntegrationService } from './external-integration.service';
import { IntegrationApiKeyGuard } from './integration-api-key.guard';

@Module({
  controllers: [
    CompanyIntegrationController,
    IntegrationClientsController,
    ExternalIntegrationController,
  ],
  providers: [
    CompanyIntegrationService,
    IntegrationClientsService,
    ExternalIntegrationService,
    IntegrationApiKeyGuard,
  ],
  exports: [
    CompanyIntegrationService,
    IntegrationClientsService,
  ],
})
export class CompanyIntegrationModule {}
