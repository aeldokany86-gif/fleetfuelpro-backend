import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Request,
  UseGuards,
} from '@nestjs/common';

import { AuthGuard } from '@nestjs/passport';

import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';

import { CompanyIntegrationService } from './company-integration.service';
import { UpdateCompanyIntegrationSettingsDto } from './dto/update-company-integration-settings.dto';

@Controller('integrations')
export class CompanyIntegrationController {
  constructor(
    private readonly companyIntegrationService: CompanyIntegrationService,
  ) {}

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Platform User')
  @Get('companies/:companyId/settings')
  async getCompanySettings(
    @Param('companyId') companyId: string,
  ) {
    return this.companyIntegrationService.getCompanySettings(companyId);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Platform User')
  @Patch('companies/:companyId/settings')
  async updateCompanySettings(
    @Param('companyId') companyId: string,
    @Body() body: UpdateCompanyIntegrationSettingsDto,
  ) {
    return this.companyIntegrationService.updateCompanySettings(
      companyId,
      body,
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin')
  @Get('settings')
  async getAuthenticatedCompanySettings(
    @Request() req,
  ) {
    return this.companyIntegrationService.getAuthenticatedCompanySettings(
      req.user.companyId,
    );
  }
}
