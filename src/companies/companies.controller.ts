import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
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
}