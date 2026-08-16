export class UploadOperationPhotoDto {
  operationNo!: string;
  ownerType!: 'station' | 'asset' | 'supplier' | 'miscellaneous';
  ownerCode!: string;
  photoType!: string;

  /*
   * Deprecated compatibility field.
   * The backend no longer trusts or uses companyId from the request body.
   * Company scope is resolved from the authenticated database user.
   */
  companyId?: string;

  // Backward-compatible aliases while the frontend is being updated.
  ownerId?: string;
  entityType?: string;
  entityCode?: string;
}
