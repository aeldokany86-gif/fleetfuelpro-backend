import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';

import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';

import { EmployeesService } from './employees.service';

import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

@Controller('employees')
export class EmployeesController {
  constructor(
    private readonly employeesService: EmployeesService,
  ) {}

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin', 'Platform User', 'PlatformAdmin')
  @Post()
  create(
    @Body() createEmployeeDto: CreateEmployeeDto,
    @Request() req,
  ) {
    return this.employeesService.create(
      createEmployeeDto,
      req.user.companyId,
      req.user.roleName || req.user.role || req.user.roleNameNormalized,
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

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin', 'Platform User', 'PlatformAdmin')
  @Get('check-id')
  checkEmployeeId(
    @Query('employeeId') employeeId: string,
    @Query('companyId') companyId: string | undefined,
    @Request() req,
  ) {
    return this.employeesService.checkEmployeeIdAvailability(
      employeeId,
      companyId,
      req.user.companyId,
      req.user.roleName || req.user.role || req.user.roleNameNormalized,
    );
  }


  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin', 'Manager', 'Platform User', 'PlatformAdmin')
  @Get(':id/project-assignments')
  getProjectAssignments(
    @Param('id') id: string,
    @Request() req,
  ) {
    return this.employeesService.getProjectAssignments(
      id,
      req.user.userId,
      req.user.companyId,
      req.user.roleName || req.user.role || req.user.roleNameNormalized,
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin', 'Manager', 'Platform User', 'PlatformAdmin')
  @Post(':id/project-assignments')
  addProjectAssignment(
    @Param('id') id: string,
    @Body() body: { projectId: string },
    @Request() req,
  ) {
    return this.employeesService.addProjectAssignment(
      id,
      body.projectId,
      req.user.userId,
      req.user.companyId,
      req.user.roleName || req.user.role || req.user.roleNameNormalized,
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin', 'Manager', 'Platform User', 'PlatformAdmin')
  @Delete(':id/project-assignments')
  removeProjectAssignments(
    @Param('id') id: string,
    @Body() body: { projectIds: string[] },
    @Request() req,
  ) {
    return this.employeesService.removeProjectAssignments(
      id,
      body.projectIds,
      req.user.userId,
      req.user.companyId,
      req.user.roleName || req.user.role || req.user.roleNameNormalized,
    );
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
