import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { MobilePushService } from './mobile-push.service';
import {
  getOperationApprovalRequiredMessage,
  getOperationApprovalResultMessage,
  normalizeNotificationLanguage,
} from './notification-messages';

type JwtRequestUser = {
  userId?: string;
  companyId?: string;
  roleId?: string;
  roleName?: string;
};

type OperationApprovalNotificationInput = {
  approverUserId: string;
  operationId: string;
  operationNo: string;
  operationType: string;
  approvalStage?: string | null;
  requestedByName?: string | null;
};

type OperationApprovalResultNotificationInput = {
  recipientUserId: string;
  operationId: string;
  operationNo: string;
  operationType: string;
  status: 'COMPLETED' | 'REJECTED';
};

type WorkflowApprovalRequiredNotificationInput = {
  recipientUserId: string;
  entityType: string;
  entityId: string;
  workflowType: string;
  reference: string;
  approvalStage?: string | null;
  requestedByName?: string | null;
  metadata?: Record<string, unknown> | null;
};

type WorkflowApprovalResultNotificationInput = {
  recipientUserId: string;
  entityType: string;
  entityId: string;
  workflowType: string;
  reference: string;
  status: 'APPROVED' | 'REJECTED';
  metadata?: Record<string, unknown> | null;
};

type CreateNotificationInput = {
  companyId: string;
  userId: string;
  type: string;
  category?: string | null;
  titleKey: string;
  messageKey: string;
  titleParams?: Record<string, unknown> | null;
  messageParams?: Record<string, unknown> | null;
  priority?: string;
  route?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  status?: string | null;
  actionable?: boolean;
  metadata?: Record<string, unknown> | null;
  dedupeKey?: string | null;
};

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mobilePushService: MobilePushService,
  ) {}

  private async resolveCurrentUser(jwtUser?: JwtRequestUser) {
    const userId = String(jwtUser?.userId || '').trim();
    const companyId = String(jwtUser?.companyId || '').trim();

    if (!userId || !companyId) {
      throw new BadRequestException('Authenticated user context is required.');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        companyId,
        deletedAt: null,
        isActive: true,
      },
      select: {
        id: true,
        companyId: true,
        preferredLanguage: true,
      },
    });

    if (!user) {
      throw new NotFoundException('Active authenticated user was not found.');
    }

    return user;
  }

  private operationTypeDescriptor(operationType: string) {
    const normalized = String(operationType || '').trim().toUpperCase();
    return {
      key: `approvals.types.${normalized}`,
      fallback: normalized.replace(/_/g, ' ') || 'Operation',
    };
  }

  private workflowTypeDescriptor(workflowType: string) {
    const normalized = String(workflowType || '').trim().toUpperCase();
    return {
      key: `approvals.types.${normalized}`,
      fallback:
        normalized === 'EMPLOYEE_TRANSFER_BATCH'
          ? 'Bulk Employee Transfer'
          : normalized.replace(/_/g, ' ') || 'Request',
    };
  }

  private getWorkflowPushLabel(
    workflowType: string,
    language: 'ar' | 'en',
  ) {
    const normalized = String(workflowType || '').trim().toUpperCase();

    const labels: Record<string, { ar: string; en: string }> = {
      ASSET_TRANSFER: { ar: 'نقل معدة', en: 'Asset Transfer' },
      ASSET_ODOMETER_RESET: { ar: 'إعادة ضبط عداد المعدة', en: 'Asset Odometer Reset' },
      STATION_TRANSFER: { ar: 'نقل محطة', en: 'Station Transfer' },
      STATION_ZERO_BALANCE: { ar: 'تصفير رصيد المحطة', en: 'Station Zero Balance' },
      STATION_COUNTER_RESET: { ar: 'إعادة ضبط عداد المحطة', en: 'Station Counter Reset' },
      STATION_INVENTORY_ADJUSTMENT: { ar: 'تسوية مخزون المحطة', en: 'Station Inventory Adjustment' },
      EMPLOYEE_TRANSFER: { ar: 'نقل موظف', en: 'Employee Transfer' },
      EMPLOYEE_TRANSFER_BATCH: { ar: 'نقل موظفين جماعي', en: 'Bulk Employee Transfer' },
      EMPLOYEE_PROJECT_REMOVAL: { ar: 'إزالة موظف من مشروع', en: 'Employee Project Removal' },
      OPERATION_CORRECTION: { ar: 'تصحيح عملية', en: 'Operation Correction' },
    };

    return (
      labels[normalized]?.[language] ||
      normalized.replace(/_/g, ' ') ||
      (language === 'ar' ? 'طلب' : 'Request')
    );
  }

  private buildWorkflowReference(input: {
    language: 'ar' | 'en';
    workflowType: string;
    reference: string;
    metadata?: Record<string, unknown> | null;
  }) {
    const reference = String(input.reference || '').trim();
    const workflowType = String(input.workflowType || '').trim().toUpperCase();

    if (workflowType === 'EMPLOYEE_PROJECT_REMOVAL') {
      const employeeCode = String(input.metadata?.employeeCode || reference || '').trim();
      const employeeName = String(input.metadata?.employeeName || '').trim();
      const projectCode = String(input.metadata?.projectCode || '').trim();
      const projectName = String(input.metadata?.projectName || '').trim();

      const employeeParts = [employeeCode, employeeName].filter(Boolean);
      const projectParts = [projectCode, projectName].filter(Boolean);

      const employeeText = employeeParts.join(' • ');
      const projectText = projectParts.join(' • ');

      if (input.language === 'ar') {
        const parts = [
          employeeText ? `الموظف: ${employeeText}` : '',
          projectText ? `المشروع: ${projectText}` : '',
        ].filter(Boolean);

        return parts.join(' - ') || reference;
      }

      const parts = [
        employeeText ? `Employee: ${employeeText}` : '',
        projectText ? `Project: ${projectText}` : '',
      ].filter(Boolean);

      return parts.join(' - ') || reference;
    }

    if (workflowType !== 'STATION_TRANSFER') {
      return reference;
    }

    const rawCurrentStock = input.metadata?.currentStock;
    const currentStock = Number(rawCurrentStock);

    if (!Number.isFinite(currentStock)) {
      return reference;
    }

    const formattedStock = new Intl.NumberFormat(
      input.language === 'ar' ? 'ar-SA' : 'en-US',
      { maximumFractionDigits: 3 },
    ).format(currentStock);

    const stockText =
      input.language === 'ar'
        ? `الرصيد الحالي: ${formattedStock} لتر`
        : `Current Stock: ${formattedStock} L`;

    return reference ? `${reference} - ${stockText}` : stockText;
  }

  private buildWorkflowPushMessage(input: {
    language: 'ar' | 'en';
    workflowType: string;
    reference: string;
    status?: 'APPROVED' | 'REJECTED';
  }) {
    const label = this.getWorkflowPushLabel(
      input.workflowType,
      input.language,
    );
    const reference = String(input.reference || '').trim();

    if (!input.status) {
      return input.language === 'ar'
        ? {
            title: 'طلب جديد يحتاج اعتمادك',
            body: reference ? `${label} - المرجع: ${reference}` : label,
          }
        : {
            title: 'New Approval Required',
            body: reference ? `${label} - Reference: ${reference}` : label,
          };
    }

    if (input.status === 'REJECTED') {
      return input.language === 'ar'
        ? {
            title: 'تم رفض الطلب',
            body: reference ? `${label} - المرجع: ${reference}` : label,
          }
        : {
            title: 'Request Rejected',
            body: reference ? `${label} - Reference: ${reference}` : label,
          };
    }

    return input.language === 'ar'
      ? {
          title: 'تم اعتماد الطلب',
          body: reference ? `${label} - المرجع: ${reference}` : label,
        }
      : {
          title: 'Request Approved',
          body: reference ? `${label} - Reference: ${reference}` : label,
        };
  }

  private async createPersistentNotification(input: CreateNotificationInput) {
    const data = {
      companyId: input.companyId,
      userId: input.userId,
      type: input.type,
      category: input.category || null,
      titleKey: input.titleKey,
      messageKey: input.messageKey,
      titleParams: input.titleParams || undefined,
      messageParams: input.messageParams || undefined,
      priority: input.priority || 'NORMAL',
      route: input.route || null,
      entityType: input.entityType || null,
      entityId: input.entityId || null,
      status: input.status || null,
      actionable: Boolean(input.actionable),
      metadata: input.metadata || undefined,
      dedupeKey: input.dedupeKey || null,
    };

    if (input.dedupeKey) {
      return (this.prisma as any).notification.upsert({
        where: { dedupeKey: input.dedupeKey },
        create: data,
        update: {},
      });
    }

    return (this.prisma as any).notification.create({ data });
  }

  async listForCurrentUser(jwtUser?: JwtRequestUser) {
    const user = await this.resolveCurrentUser(jwtUser);

    const items = await (this.prisma as any).notification.findMany({
      where: {
        userId: user.id,
        companyId: user.companyId,
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    });

    return {
      items: items.map((item: any) => ({
        ...item,
        read: Boolean(item.readAt),
      })),
      count: items.length,
      unreadCount: items.filter((item: any) => !item.readAt).length,
    };
  }

  async getUnreadCount(jwtUser?: JwtRequestUser) {
    const user = await this.resolveCurrentUser(jwtUser);

    const count = await (this.prisma as any).notification.count({
      where: {
        userId: user.id,
        companyId: user.companyId,
        readAt: null,
      },
    });

    return { count };
  }

  async markRead(notificationId: string, jwtUser?: JwtRequestUser) {
    const user = await this.resolveCurrentUser(jwtUser);
    const id = String(notificationId || '').trim();

    if (!id) {
      throw new BadRequestException('Notification id is required.');
    }

    const result = await (this.prisma as any).notification.updateMany({
      where: {
        id,
        userId: user.id,
        companyId: user.companyId,
        readAt: null,
      },
      data: {
        readAt: new Date(),
      },
    });

    if (result.count === 0) {
      const exists = await (this.prisma as any).notification.findFirst({
        where: {
          id,
          userId: user.id,
          companyId: user.companyId,
        },
        select: { id: true },
      });

      if (!exists) {
        throw new NotFoundException('Notification was not found.');
      }
    }

    return { ok: true };
  }

  async markAllRead(jwtUser?: JwtRequestUser) {
    const user = await this.resolveCurrentUser(jwtUser);

    const result = await (this.prisma as any).notification.updateMany({
      where: {
        userId: user.id,
        companyId: user.companyId,
        readAt: null,
      },
      data: {
        readAt: new Date(),
      },
    });

    return {
      ok: true,
      updated: result.count,
    };
  }



  async closeWorkflowApprovalRequired(input: {
    entityType: string;
    entityId: string;
    userId: string;
    status: 'APPROVED' | 'REJECTED';
  }) {
    const entityType = String(input.entityType || '').trim().toUpperCase();
    const entityId = String(input.entityId || '').trim();
    const userId = String(input.userId || '').trim();

    if (!entityType || !entityId || !userId) {
      return { updated: 0 };
    }

    const result = await (this.prisma as any).notification.updateMany({
      where: {
        userId,
        entityType,
        entityId,
        type: 'WORKFLOW_APPROVAL_REQUIRED',
        actionable: true,
      },
      data: {
        actionable: false,
        status: input.status,
      },
    });

    return { updated: result.count };
  }

  async sendWorkflowApprovalRequired(
    input: WorkflowApprovalRequiredNotificationInput,
  ) {
    const recipientUserId = String(input.recipientUserId || '').trim();
    const entityType = String(input.entityType || '').trim().toUpperCase();
    const entityId = String(input.entityId || '').trim();
    const workflowType = String(input.workflowType || '').trim().toUpperCase();
    const reference = String(input.reference || '').trim();
    const approvalStage = String(input.approvalStage || '').trim() || null;

    if (!recipientUserId || !entityType || !entityId || !workflowType) {
      return {
        skipped: true,
        reason: 'WORKFLOW_NOTIFICATION_CONTEXT_MISSING',
      };
    }

    const recipient = await this.prisma.user.findFirst({
      where: {
        id: recipientUserId,
        deletedAt: null,
        isActive: true,
      },
      select: {
        id: true,
        companyId: true,
        preferredLanguage: true,
      },
    });

    if (!recipient) {
      return {
        skipped: true,
        reason: 'RECIPIENT_NOT_ACTIVE',
      };
    }

    const workflowTypeDescriptor = this.workflowTypeDescriptor(workflowType);
    const language = normalizeNotificationLanguage(recipient.preferredLanguage);
    const displayReference = this.buildWorkflowReference({
      language,
      workflowType,
      reference,
      metadata: input.metadata || null,
    });

    const notification = await this.createPersistentNotification({
      companyId: recipient.companyId,
      userId: recipient.id,
      type: 'WORKFLOW_APPROVAL_REQUIRED',
      category: 'APPROVAL',
      titleKey: 'notifications.workflowApproval.requiredTitle',
      messageKey: 'notifications.workflowApproval.requiredMessage',
      messageParams: {
        workflowType: workflowTypeDescriptor,
        reference: displayReference,
      },
      priority: 'HIGH',
      route: 'approvals',
      entityType,
      entityId,
      status: 'PENDING',
      actionable: true,
      metadata: {
        workflowType,
        reference,
        approvalStage,
        requestedByName: input.requestedByName || null,
        ...(input.metadata || {}),
      },
      dedupeKey:
        `workflow-approval-required:${entityType}:${entityId}:${recipient.id}:${approvalStage || 'default'}`,
    });

    const message = this.buildWorkflowPushMessage({
      language,
      workflowType,
      reference: displayReference,
    });

    let pushDelivery: Record<string, unknown>;
    try {
      pushDelivery = await this.mobilePushService.sendToUser(recipient.id, {
        title: message.title,
        body: message.body,
        data: {
          type: 'WORKFLOW_APPROVAL_REQUIRED',
          screen: 'approvals',
          notificationId: notification.id,
          entityType,
          entityId,
          workflowType,
          reference,
          approvalStage,
        },
        sound: 'default',
      });
    } catch (error) {
      pushDelivery = {
        registeredDevices: 0,
        accepted: 0,
        failed: 0,
        error: error instanceof Error ? error.message : 'Push delivery failed.',
      };
    }

    return {
      notificationId: notification.id,
      persisted: true,
      pushDelivery,
    };
  }

  async sendWorkflowApprovalResult(
    input: WorkflowApprovalResultNotificationInput,
  ) {
    const recipientUserId = String(input.recipientUserId || '').trim();
    const entityType = String(input.entityType || '').trim().toUpperCase();
    const entityId = String(input.entityId || '').trim();
    const workflowType = String(input.workflowType || '').trim().toUpperCase();
    const reference = String(input.reference || '').trim();

    if (!recipientUserId || !entityType || !entityId || !workflowType) {
      return {
        skipped: true,
        reason: 'WORKFLOW_NOTIFICATION_CONTEXT_MISSING',
      };
    }

    const recipient = await this.prisma.user.findFirst({
      where: {
        id: recipientUserId,
        deletedAt: null,
        isActive: true,
      },
      select: {
        id: true,
        companyId: true,
        preferredLanguage: true,
      },
    });

    if (!recipient) {
      return {
        skipped: true,
        reason: 'RECIPIENT_NOT_ACTIVE',
      };
    }

    await this.closeWorkflowApprovalRequired({
      entityType,
      entityId,
      userId: recipient.id,
      status: input.status,
    });

    const workflowTypeDescriptor = this.workflowTypeDescriptor(workflowType);
    const language = normalizeNotificationLanguage(recipient.preferredLanguage);
    const displayReference = this.buildWorkflowReference({
      language,
      workflowType,
      reference,
      metadata: input.metadata || null,
    });

    const notification = await this.createPersistentNotification({
      companyId: recipient.companyId,
      userId: recipient.id,
      type: 'WORKFLOW_APPROVAL_RESULT',
      category: 'APPROVAL_RESULT',
      titleKey:
        input.status === 'APPROVED'
          ? 'notifications.workflowApproval.approvedTitle'
          : 'notifications.workflowApproval.rejectedTitle',
      messageKey:
        input.status === 'APPROVED'
          ? 'notifications.workflowApproval.approvedMessage'
          : 'notifications.workflowApproval.rejectedMessage',
      messageParams: {
        workflowType: workflowTypeDescriptor,
        reference: displayReference,
      },
      priority: input.status === 'APPROVED' ? 'NORMAL' : 'HIGH',
      route: 'notifications',
      entityType,
      entityId,
      status: input.status,
      actionable: false,
      metadata: {
        workflowType,
        reference,
        ...(input.metadata || {}),
      },
      dedupeKey:
        `workflow-approval-result:${entityType}:${entityId}:${recipient.id}:${input.status}`,
    });

    const message = this.buildWorkflowPushMessage({
      language,
      workflowType,
      reference: displayReference,
      status: input.status,
    });

    let pushDelivery: Record<string, unknown>;
    try {
      pushDelivery = await this.mobilePushService.sendToUser(recipient.id, {
        title: message.title,
        body: message.body,
        data: {
          type: 'WORKFLOW_APPROVAL_RESULT',
          screen: 'notifications',
          notificationId: notification.id,
          entityType,
          entityId,
          workflowType,
          reference,
          status: input.status,
        },
        sound: 'default',
      });
    } catch (error) {
      pushDelivery = {
        registeredDevices: 0,
        accepted: 0,
        failed: 0,
        error: error instanceof Error ? error.message : 'Push delivery failed.',
      };
    }

    return {
      notificationId: notification.id,
      persisted: true,
      pushDelivery,
    };
  }

  async closeOperationApprovalRequired(input: {
    operationId: string;
    userId: string;
    status: 'APPROVED' | 'REJECTED';
  }) {
    const operationId = String(input.operationId || '').trim();
    const userId = String(input.userId || '').trim();

    if (!operationId || !userId) return { updated: 0 };

    const result = await (this.prisma as any).notification.updateMany({
      where: {
        userId,
        entityType: 'OPERATION',
        entityId: operationId,
        type: 'OPERATION_APPROVAL_REQUIRED',
        actionable: true,
      },
      data: {
        actionable: false,
        status: input.status,
      },
    });

    return { updated: result.count };
  }

  async sendOperationApprovalRequired(
    input: OperationApprovalNotificationInput,
  ) {
    const approverUserId = String(input.approverUserId || '').trim();

    if (!approverUserId) {
      return {
        skipped: true,
        reason: 'APPROVER_USER_ID_MISSING',
      };
    }

    const approver = await this.prisma.user.findFirst({
      where: {
        id: approverUserId,
        deletedAt: null,
        isActive: true,
      },
      select: {
        id: true,
        companyId: true,
        preferredLanguage: true,
      },
    });

    if (!approver) {
      return {
        skipped: true,
        reason: 'APPROVER_NOT_ACTIVE',
      };
    }

    const operationNo = String(input.operationNo || '').trim();
    const operationType = String(input.operationType || '').trim().toUpperCase();
    const approvalStage = String(input.approvalStage || '').trim() || null;
    const operationTypeDescriptor = this.operationTypeDescriptor(operationType);

    const notification = await this.createPersistentNotification({
      companyId: approver.companyId,
      userId: approver.id,
      type: 'OPERATION_APPROVAL_REQUIRED',
      category: 'APPROVAL',
      titleKey: 'notifications.operationApproval.requiredTitle',
      messageKey: 'notifications.operationApproval.requiredMessage',
      messageParams: {
        operationNo,
        operationType: operationTypeDescriptor,
      },
      priority: 'HIGH',
      route: 'approvals',
      entityType: 'OPERATION',
      entityId: input.operationId,
      status: 'PENDING',
      actionable: true,
      metadata: {
        operationNo,
        operationType,
        approvalStage,
        requestedByName: input.requestedByName || null,
      },
      dedupeKey: `operation-approval-required:${input.operationId}:${approver.id}:${approvalStage || 'default'}`,
    });

    const language = normalizeNotificationLanguage(approver.preferredLanguage);
    const message = getOperationApprovalRequiredMessage({
      language,
      operationType,
      operationNo,
    });

    let pushDelivery: Record<string, unknown>;
    try {
      pushDelivery = await this.mobilePushService.sendToUser(approver.id, {
        title: message.title,
        body: message.body,
        data: {
          type: 'OPERATION_APPROVAL_REQUIRED',
          screen: 'approvals',
          notificationId: notification.id,
          operationId: input.operationId,
          operationNo,
          operationType,
          approvalStage,
        },
        sound: 'default',
      });
    } catch (error) {
      pushDelivery = {
        registeredDevices: 0,
        accepted: 0,
        failed: 0,
        error: error instanceof Error ? error.message : 'Push delivery failed.',
      };
    }

    return {
      notificationId: notification.id,
      persisted: true,
      pushDelivery,
    };
  }

  async sendOperationApprovalResult(
    input: OperationApprovalResultNotificationInput,
  ) {
    const recipientUserId = String(input.recipientUserId || '').trim();

    if (!recipientUserId) {
      return {
        skipped: true,
        reason: 'RECIPIENT_USER_ID_MISSING',
      };
    }

    const recipient = await this.prisma.user.findFirst({
      where: {
        id: recipientUserId,
        deletedAt: null,
        isActive: true,
      },
      select: {
        id: true,
        companyId: true,
        preferredLanguage: true,
      },
    });

    if (!recipient) {
      return {
        skipped: true,
        reason: 'RECIPIENT_NOT_ACTIVE',
      };
    }

    const operationNo = String(input.operationNo || '').trim();
    const operationType = String(input.operationType || '').trim().toUpperCase();
    const operationTypeDescriptor = this.operationTypeDescriptor(operationType);
    const approved = input.status === 'COMPLETED';

    // A terminal result closes any older approval-required card for this user.
    // This keeps the persistent center truthful even when the push was received
    // on another device or the approval was completed before the card was opened.
    await this.closeOperationApprovalRequired({
      operationId: input.operationId,
      userId: recipient.id,
      status: approved ? 'APPROVED' : 'REJECTED',
    });

    const notification = await this.createPersistentNotification({
      companyId: recipient.companyId,
      userId: recipient.id,
      type: 'OPERATION_APPROVAL_RESULT',
      category: 'APPROVAL_RESULT',
      titleKey: approved
        ? 'notifications.operationApproval.approvedTitle'
        : 'notifications.operationApproval.rejectedTitle',
      messageKey: approved
        ? 'notifications.operationApproval.approvedMessage'
        : 'notifications.operationApproval.rejectedMessage',
      messageParams: {
        operationNo,
        operationType: operationTypeDescriptor,
      },
      priority: approved ? 'NORMAL' : 'HIGH',
      route: 'notifications',
      entityType: 'OPERATION',
      entityId: input.operationId,
      status: input.status,
      actionable: false,
      metadata: {
        operationNo,
        operationType,
      },
      dedupeKey: `operation-approval-result:${input.operationId}:${recipient.id}:${input.status}`,
    });

    const language = normalizeNotificationLanguage(recipient.preferredLanguage);
    const message = getOperationApprovalResultMessage({
      language,
      operationType,
      operationNo,
      status: input.status,
    });

    let pushDelivery: Record<string, unknown>;
    try {
      pushDelivery = await this.mobilePushService.sendToUser(recipient.id, {
        title: message.title,
        body: message.body,
        data: {
          type: 'OPERATION_APPROVAL_RESULT',
          screen: 'notifications',
          notificationId: notification.id,
          operationId: input.operationId,
          operationNo,
          operationType,
          status: input.status,
        },
        sound: 'default',
      });
    } catch (error) {
      pushDelivery = {
        registeredDevices: 0,
        accepted: 0,
        failed: 0,
        error: error instanceof Error ? error.message : 'Push delivery failed.',
      };
    }

    return {
      notificationId: notification.id,
      persisted: true,
      pushDelivery,
    };
  }
}
