export class UploadOperationPhotoDto {
  ownerType!: 'station' | 'asset' | 'supplier' | 'miscellaneous';
  ownerCode!: string;
  photoType!: string;

  // WEB is the backward-compatible default for the existing frontend.
  // Mobile will explicitly send CAMERA or GALLERY when photo capture is enabled.
  captureSource?: 'WEB' | 'CAMERA' | 'GALLERY';

  /*
   * Deprecated compatibility fields.
   * The backend no longer trusts companyId and no longer uses operationNo
   * to build the storage file name.
   */
  companyId?: string;
  operationNo?: string;

  // Backward-compatible aliases while the frontend is being updated.
  ownerId?: string;
  entityType?: string;
  entityCode?: string;
}
