import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { AuthGuard } from '@nestjs/passport';

import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
  ) {}

  @Get('login-company')
  async getLoginCompany(
    @Query('identifier') identifier: string,
    @Query('email') email?: string,
  ) {
    return this.authService.getLoginCompany(identifier || email || '');
  }

  @Post('login')
  async login(
    @Body() body: { identifier?: string; email?: string; username?: string; password: string },
  ) {
    return this.authService.login(
      body.identifier || body.username || body.email || '',
      body.password,
    );
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('me')
  async me(@Req() req: any) {
    return this.authService.getMe(
      req.user.userId,
    );
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch('change-password')
  async changePassword(
    @Req() req: any,
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    return this.authService.changePassword(
      req.user.userId,
      body.currentPassword,
      body.newPassword,
    );
  }
}
