export class UploadOperationPhotoDto {
  companyId!: string;
  operationNo!: string;
  ownerType!: 'station' | 'asset' | 'supplier' | 'miscellaneous';
  ownerCode!: string;
  photoType!: string;

  // Backward-compatible aliases while the frontend is being updated.
  ownerId?: string;
  entityType?: string;
  entityCode?: string;
}
