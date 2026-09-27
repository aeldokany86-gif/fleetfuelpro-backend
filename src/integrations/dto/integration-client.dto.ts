export class CreateIntegrationClientDto {
  name: string;
  scopes?: string[];
}

export class UpdateIntegrationClientDto {
  name?: string;
  scopes?: string[];
}

export class UpdateIntegrationClientStatusDto {
  enabled: boolean;
}
