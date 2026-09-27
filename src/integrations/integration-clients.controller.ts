import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';

import { IntegrationClientsService } from './integration-clients.service';
import {
  CreateIntegrationClientDto,
  UpdateIntegrationClientDto,
  UpdateIntegrationClientStatusDto,
} from './dto/integration-client.dto';

@Controller('integrations')
export class IntegrationClientsController {
  constructor(
    private readonly integrationClientsService: IntegrationClientsService,
  ) {}

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Platform User')
  @Get('companies/:companyId/clients')
  async listCompanyClients(
    @Param('companyId') companyId: string,
  ) {
    return this.integrationClientsService.listCompanyClients(companyId);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin')
  @Get('clients')
  async listAuthenticatedCompanyClients(
    @Request() req,
  ) {
    return this.integrationClientsService.listAuthenticatedCompanyClients(
      req.user.companyId,
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin')
  @Post('clients')
  async createClient(
    @Request() req,
    @Body() body: CreateIntegrationClientDto,
  ) {
    return this.integrationClientsService.createClient(
      req.user.companyId,
      body,
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin')
  @Patch('clients/:clientId')
  async updateClient(
    @Request() req,
    @Param('clientId') clientId: string,
    @Body() body: UpdateIntegrationClientDto,
  ) {
    return this.integrationClientsService.updateClient(
      req.user.companyId,
      clientId,
      body,
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin')
  @Patch('clients/:clientId/status')
  async updateClientStatus(
    @Request() req,
    @Param('clientId') clientId: string,
    @Body() body: UpdateIntegrationClientStatusDto,
  ) {
    return this.integrationClientsService.updateClientStatus(
      req.user.companyId,
      clientId,
      body.enabled,
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin')
  @Post('clients/:clientId/rotate-key')
  async rotateApiKey(
    @Request() req,
    @Param('clientId') clientId: string,
  ) {
    return this.integrationClientsService.rotateApiKey(
      req.user.companyId,
      clientId,
    );
  }
}
