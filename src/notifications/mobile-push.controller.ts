import {
  Body,
  Controller,
  Delete,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { MobilePushService } from './mobile-push.service';

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
export class MobilePushController {
  constructor(private readonly mobilePushService: MobilePushService) {}

  @Post('devices')
  async registerDevice(
    @Body() body: RegisterDeviceBody,
    @Req() request: JwtRequest,
  ) {
    return this.mobilePushService.registerDevice(body, request.user);
  }

  @Delete('devices')
  async unregisterDevice(
    @Body() body: UnregisterDeviceBody,
    @Req() request: JwtRequest,
  ) {
    return this.mobilePushService.unregisterDevice(body, request.user);
  }

  @Post('test')
  async sendTestPush(@Req() request: JwtRequest) {
    return this.mobilePushService.sendTestPush(request.user);
  }
}
