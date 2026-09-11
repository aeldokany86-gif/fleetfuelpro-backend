import {
  Body,
  Controller,
  Delete,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { MobileNotificationsService } from './mobile-notifications.service';

type JwtRequestUser = {
  userId?: string;
  companyId?: string;
  roleId?: string;
  roleName?: string;
};

type JwtRequest = {
  user?: JwtRequestUser;
};

type RegisterDeviceBody = {
  installationId?: string;
  expoPushToken?: string;
  platform?: string;
  deviceName?: string;
  appVersion?: string;
};

type UnregisterDeviceBody = {
  installationId?: string;
};

@Controller('mobile/notifications')
@UseGuards(AuthGuard('jwt'))
export class MobileNotificationsController {
  constructor(
    private readonly mobileNotificationsService: MobileNotificationsService,
  ) {}

  @Post('devices')
  async registerDevice(
    @Body() body: RegisterDeviceBody,
    @Req() request: JwtRequest,
  ) {
    return this.mobileNotificationsService.registerDevice(body, request.user);
  }

  @Delete('devices')
  async unregisterDevice(
    @Body() body: UnregisterDeviceBody,
    @Req() request: JwtRequest,
  ) {
    return this.mobileNotificationsService.unregisterDevice(body, request.user);
  }

  @Post('test')
  async sendTestPush(@Req() request: JwtRequest) {
    return this.mobileNotificationsService.sendTestPush(request.user);
  }
}
