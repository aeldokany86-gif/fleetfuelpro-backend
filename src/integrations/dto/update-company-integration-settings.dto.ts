export class CompanyIntegrationWebhookEventDto {
  eventType: string;
  enabled: boolean;
}

export class UpdateCompanyIntegrationSettingsDto {
  enabled?: boolean;

  operationsSummaryEnabled?: boolean;
  operationsDetailsEnabled?: boolean;
  costDataEnabled?: boolean;
  stockReadEnabled?: boolean;
  stockMovementsEnabled?: boolean;

  webhooksEnabled?: boolean;

  externalMappingEnabled?: boolean;
  externalMappingManualEnabled?: boolean;
  externalMappingImportEnabled?: boolean;

  clientLimit?: number;

  webhookEvents?: CompanyIntegrationWebhookEventDto[];
}
