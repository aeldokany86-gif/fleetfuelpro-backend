export type MobileNotificationLanguage = 'ar' | 'en';

export type OperationApprovalNotificationMessageInput = {
  language: MobileNotificationLanguage;
  operationType: string;
  operationNo: string;
};

export type OperationApprovalResultMessageInput = {
  language: MobileNotificationLanguage;
  operationType: string;
  operationNo: string;
  status: 'COMPLETED' | 'REJECTED';
};

const OPERATION_TYPE_LABELS: Record<
  string,
  { ar: string; en: string }
> = {
  EXTERNAL_DIRECT_REFUEL: {
    ar: 'تعبئة مباشرة خارجية',
    en: 'External Direct Refuel',
  },
  EXTERNAL_SUPPLY: {
    ar: 'توريد خارجي',
    en: 'External Supply',
  },
  EXTERNAL_TRANSFER: {
    ar: 'نقل خارجي',
    en: 'External Transfer',
  },
};

export function normalizeMobileNotificationLanguage(
  value: unknown,
): MobileNotificationLanguage {
  return String(value || '').trim().toLowerCase() === 'ar' ? 'ar' : 'en';
}

export function getOperationTypeNotificationLabel(
  operationType: string,
  language: MobileNotificationLanguage,
) {
  const normalized = String(operationType || '').trim().toUpperCase();
  const label = OPERATION_TYPE_LABELS[normalized];

  if (!label) {
    return normalized || (language === 'ar' ? 'عملية' : 'Operation');
  }

  return label[language];
}

export function getOperationApprovalRequiredMessage(
  input: OperationApprovalNotificationMessageInput,
) {
  const operationTypeLabel = getOperationTypeNotificationLabel(
    input.operationType,
    input.language,
  );

  if (input.language === 'ar') {
    return {
      title: 'طلب جديد يحتاج اعتمادك',
      body: `${operationTypeLabel} - رقم العملية: ${input.operationNo}`,
    };
  }

  return {
    title: 'New Approval Required',
    body: `${operationTypeLabel} - Operation No: ${input.operationNo}`,
  };
}


export function getOperationApprovalResultMessage(
  input: OperationApprovalResultMessageInput,
) {
  const operationTypeLabel = getOperationTypeNotificationLabel(
    input.operationType,
    input.language,
  );

  if (input.language === 'ar') {
    if (input.status === 'REJECTED') {
      return {
        title: 'تم رفض العملية',
        body: `${operationTypeLabel} - رقم العملية: ${input.operationNo}`,
      };
    }

    return {
      title: 'تم اعتماد العملية',
      body: `${operationTypeLabel} - رقم العملية: ${input.operationNo}`,
    };
  }

  if (input.status === 'REJECTED') {
    return {
      title: 'Operation Rejected',
      body: `${operationTypeLabel} - Operation No: ${input.operationNo}`,
    };
  }

  return {
    title: 'Operation Approved',
    body: `${operationTypeLabel} - Operation No: ${input.operationNo}`,
  };
}

export function getMobilePushTestMessage(language: MobileNotificationLanguage) {
  if (language === 'ar') {
    return {
      title: 'Fleet Fuel PRO',
      body: 'تم تفعيل إشعارات الموبايل بنجاح.',
    };
  }

  return {
    title: 'Fleet Fuel PRO',
    body: 'Mobile push notifications are working successfully.',
  };
}
