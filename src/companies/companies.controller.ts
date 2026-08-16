import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';

import { AuthGuard } from '@nestjs/passport';

import { CompaniesService } from './companies.service';

import { CreateCompanyDto } from './dto/create-company.dto';

import { UpdateCompanyDto } from './dto/update-company.dto';

import { Roles } from '../auth/roles.decorator';

import { RolesGuard } from '../auth/roles.guard';

@Controller('companies')
export class CompaniesController {
  constructor(
    private readonly companiesService: CompaniesService,
  ) {}

  @Get('public')
  async findPublicCompanies() {
    return this.companiesService.findPublicCompanies();
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Platform User')
  @Get()
  async findAll() {
    return this.companiesService.findAll();
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Platform User')
  @Get('reports/master')
  async getMasterReport(
    @Query('companyId') companyId?: string,
    @Query('status') status?: string,
    @Query('createdFrom') createdFrom?: string,
    @Query('createdTo') createdTo?: string,
  ) {
    return this.companiesService.getMasterReport({
      companyId,
      status,
      createdFrom,
      createdTo,
    });
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Platform User')
  @Post()
  async create(@Body() body: CreateCompanyDto) {
    return this.companiesService.create(body);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Platform User')
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: UpdateCompanyDto,
  ) {
    return this.companiesService.update(id, body);
  }
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Platform User')
  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { isActive: boolean },
  ) {
    return this.companiesService.updateStatus(id, body.isActive);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Platform User')
  @Patch(':id/data-import-access')
  async updateDataImportAccess(
    @Param('id') id: string,
    @Body() body: { enabled: boolean },
  ) {
    return this.companiesService.updateDataImportAccess(id, body.enabled);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Platform User')
  @Patch(':id/multi-project-access')
  async updateMultiProjectAccess(
    @Param('id') id: string,
    @Body() body: { enabled: boolean },
  ) {
    return this.companiesService.updateMultiProjectAccess(id, body.enabled);
  }


  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin')
  @Get('settings/mobile-application')
  async getMobileApplicationSettings(
    @Request() req,
  ) {
    return this.companiesService.getMobileApplicationSettings(
      req.user.companyId,
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin')
  @Patch('settings/mobile-application')
  async updateMobileApplicationSettings(
    @Body()
    body: {
      mobilePhotoSourcePolicy?: 'CAMERA_ONLY' | 'CAMERA_AND_GALLERY';
      saveCapturedPhotosToDeviceGallery?: boolean;
    },
    @Request() req,
  ) {
    return this.companiesService.updateMobileApplicationSettings(
      req.user.companyId,
      body,
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin')
  @Get('settings/station-negative-tolerance')
  async getStationNegativeTolerance(
    @Request() req,
  ) {
    return this.companiesService.getStationNegativeTolerance(
      req.user.companyId,
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin')
  @Patch('settings/station-negative-tolerance')
  async updateStationNegativeTolerance(
    @Body() body: { percent: number },
    @Request() req,
  ) {
    return this.companiesService.updateStationNegativeTolerance(
      req.user.companyId,
      body.percent,
    );
  }


}