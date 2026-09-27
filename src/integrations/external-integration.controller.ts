import {
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { IntegrationApiKeyGuard } from './integration-api-key.guard';
import { RequireIntegrationScope } from './integration-scope.decorator';
import { ExternalIntegrationService } from './external-integration.service';

@Controller('integration/v1')
@UseGuards(IntegrationApiKeyGuard)
export class ExternalIntegrationController {
  constructor(
    private readonly externalIntegrationService: ExternalIntegrationService,
  ) {}

  @Get('operations/summary')
  @RequireIntegrationScope('operations.summary')
  getOperationsSummary(
    @Req() req: any,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('assetCode') assetCode?: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.externalIntegrationService.getOperationsSummary(
      req.integration,
      {
        dateFrom,
        dateTo,
        assetCode,
        projectId,
      },
    );
  }

  @Get('stock')
  @RequireIntegrationScope('stock.read')
  getCurrentStock(
    @Req() req: any,
    @Query('projectId') projectId?: string,
    @Query('stationId') stationId?: string,
  ) {
    return this.externalIntegrationService.getCurrentStock(
      req.integration,
      {
        projectId,
        stationId,
      },
    );
  }
}
