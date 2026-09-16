import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { MobileApprovalsService } from './mobile-approvals.service';

type JwtRequestUser = {
  userId?: string;
  companyId?: string;
  roleId?: string;
  roleName?: string;
};

type JwtRequest = {
  user?: JwtRequestUser;
};

type MobileApprovalReviewBody = {
  action?: string;
  note?: string;
  requestIds?: string[];
};

@Controller('mobile/approvals')
@UseGuards(AuthGuard('jwt'))
export class MobileApprovalsController {
  constructor(
    private readonly mobileApprovalsService: MobileApprovalsService,
  ) {}

  @Get()
  async getInbox(@Req() request: JwtRequest) {
    return this.mobileApprovalsService.getInbox(request.user);
  }

  @Patch(':type/:id/review')
  async review(
    @Param('type') type: string,
    @Param('id') id: string,
    @Body() body: MobileApprovalReviewBody,
    @Req() request: JwtRequest,
  ) {
    const action = String(body?.action || '').trim().toUpperCase();

    if (!['APPROVE', 'REJECT'].includes(action)) {
      throw new BadRequestException(
        'Review action must be APPROVE or REJECT.',
      );
    }

    return this.mobileApprovalsService.review(
      type,
      id,
      {
        action: action as 'APPROVE' | 'REJECT',
        note: body?.note,
        requestIds: Array.isArray(body?.requestIds) ? body.requestIds : undefined,
      },
      request.user,
    );
  }
}
