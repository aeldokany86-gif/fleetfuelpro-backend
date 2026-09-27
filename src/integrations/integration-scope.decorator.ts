import { SetMetadata } from '@nestjs/common';

export const INTEGRATION_SCOPE_METADATA_KEY = 'integration_required_scope';

export const RequireIntegrationScope = (scope: string) =>
  SetMetadata(INTEGRATION_SCOPE_METADATA_KEY, scope);
