import {
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { NotificationsService } from './notifications.service';

type JwtRequestUser = {
  userId?: string;
  companyId?: string;
  roleId?: string;
  roleName?: string;
};

type JwtRequest = {
  user?: JwtRequestUser;
};

@Controller('notifications')
@UseGuards(AuthGuard('jwt'))
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  async list(@Req() request: JwtRequest) {
    return this.notificationsService.listForCurrentUser(request.user);
  }

  @Get('unread-count')
  async unreadCount(@Req() request: JwtRequest) {
    return this.notificationsService.getUnreadCount(request.user);
  }

  @Patch('read-all')
  async markAllRead(@Req() request: JwtRequest) {
    return this.notificationsService.markAllRead(request.user);
  }

  @Patch(':id/read')
  async markRead(
    @Param('id') notificationId: string,
    @Req() request: JwtRequest,
  ) {
    return this.notificationsService.markRead(notificationId, request.user);
  }
}
