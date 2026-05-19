import {
  Controller,
  Get,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';

import { AuthGuard } from '@nestjs/passport';

import { RolesService } from './roles.service';

@Controller('roles')
export class RolesController {
  constructor(
    private readonly rolesService: RolesService,
  ) {}

  @UseGuards(AuthGuard('jwt'))
  @Get()
  async findAll(
    @Request() req,
    @Query('companyId') companyId?: string,
  ) {
    return this.rolesService.findAll(
      req.user.companyId,
      req.user.roleName || req.user.role || req.user.roleNameNormalized,
      companyId,
    );
  }
}
