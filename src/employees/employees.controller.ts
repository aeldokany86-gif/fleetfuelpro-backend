import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { EmployeesService } from './employees.service';

import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

@Controller('employees')
export class EmployeesController {
  constructor(
    private readonly employeesService: EmployeesService,
  ) {}

  @Post()
  create(
    @Body() createEmployeeDto: CreateEmployeeDto,
  ) {
    return this.employeesService.create(
      createEmployeeDto,
    );
  }

  @Get()
  findAll(
    @Query('companyId') companyId?: string,
    @Query('projectId') projectId?: string,
    @Query('status') status?: string,
  ) {
    return this.employeesService.findAll(
      companyId,
      projectId,
      status,
    );
  }

  @Get('active-projects')
  getActiveProjects(
    @Query('companyId') companyId: string,
  ) {
    return this.employeesService.getActiveProjects(
      companyId,
    );
  }

  @Get('report/master')
  masterReport(
    @Query('companyId') companyId: string,
    @Query('projectId') projectId?: string,
    @Query('status') status?: string,
    @Query('jobTitle') jobTitle?: string,
    @Query('employeeCode') employeeCode?: string,
    @Query('linkedStatus') linkedStatus?: string,
  ) {
    return this.employeesService.getMasterReport({
      companyId,
      projectId,
      status,
      jobTitle,
      employeeCode,
      linkedStatus,
    });
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
  ) {
    return this.employeesService.findOne(
      id,
    );
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateEmployeeDto: UpdateEmployeeDto,
  ) {
    return this.employeesService.update(
      id,
      updateEmployeeDto,
    );
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
  ) {
    return this.employeesService.remove(
      id,
    );
  }
}
