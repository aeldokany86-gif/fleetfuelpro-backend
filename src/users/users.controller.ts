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

import { UsersService } from './users.service';

import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';

import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ResetUserPasswordDto } from './dto/reset-user-password.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin', 'Platform User', 'PlatformAdmin', 'Platform User')
  @Get()
  async findAll(
    @Request() req,
    @Query('companyId') selectedCompanyId?: string,
  ) {
    return this.usersService.findAll(
      req.user.companyId,
      req.user.roleName || req.user.role || req.user.roleNameNormalized,
      selectedCompanyId,
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin', 'Platform User', 'PlatformAdmin', 'Platform User')
  @Post()
  async create(
    @Body() createUserDto: CreateUserDto,
    @Request() req,
  ) {
    return this.usersService.create(
      createUserDto,
      req.user.companyId,
      req.user.roleName || req.user.role || req.user.roleNameNormalized,
      req.user.userId || req.user.id,
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin', 'Platform User', 'PlatformAdmin', 'Platform User')
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
    @Request() req,
  ) {
    return this.usersService.update(
      id,
      updateUserDto,
      req.user.companyId,
      req.user.roleName || req.user.role || req.user.roleNameNormalized,
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin', 'Platform User', 'PlatformAdmin', 'Platform User')
  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { isActive: boolean },
    @Request() req,
  ) {
    return this.usersService.updateStatus(
      id,
      body.isActive,
      req.user.companyId,
      req.user.roleName || req.user.role || req.user.roleNameNormalized,
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles('Admin', 'Platform User', 'PlatformAdmin', 'Platform User')
  @Patch(':id/reset-password')
  async resetPassword(
    @Param('id') id: string,
    @Body() dto: ResetUserPasswordDto,
    @Request() req,
  ) {
    return this.usersService.resetPassword(
      id,
      dto,
      req.user.companyId,
      req.user.roleName || req.user.role || req.user.roleNameNormalized,
    );
  }
}
