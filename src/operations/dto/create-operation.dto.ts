import {
  IsArray,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export enum OperationTypeDto {
  DIRECT_REFUEL = 'DIRECT_REFUEL',
  EXTERNAL_DIRECT_REFUEL = 'EXTERNAL_DIRECT_REFUEL',
  INTERNAL_TRANSFER = 'INTERNAL_TRANSFER',
  EXTERNAL_SUPPLY = 'EXTERNAL_SUPPLY',
  EXTERNAL_TRANSFER = 'EXTERNAL_TRANSFER',

  // Frontend legacy values. The service normalizes these values.
  Direct_Refuel = 'Direct_Refuel',
  External_Direct_Refuel = 'External_Direct_Refuel',
  Internal_Transfer = 'Internal_Transfer',
  External_Supply = 'External_Supply',
  External_Transfer = 'External_Transfer',
}

export type OperationAttachmentDto = {
  key?: string;
  label?: string;
  fileName?: string;
  path?: string;
  bucket?: string;
  photoType?: string;
  ownerType?: string;
  ownerCode?: string;
  mimeType?: string;
  size?: number | string;
  sizeBytes?: number | string;
  draftId?: string;
  draftStatus?: 'PENDING' | 'CONSUMED';
  captureSource?: 'WEB' | 'CAMERA' | 'GALLERY';
};

export class CreateOperationDto {
  @IsEnum(OperationTypeDto)
  type!: OperationTypeDto;

  @IsOptional()
  @IsString()
  sourceStationId?: string;

  @IsOptional()
  @IsString()
  destinationStationId?: string;

  @IsOptional()
  @IsString()
  assetId?: string;

  /*
    Active operational project selected by the user.
    Required by the service for multi-project Officer/Supervisor/Operator users.
  */
  @IsOptional()
  @IsString()
  currentProjectId?: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;

  /*
    Real-world time when the operation actually happened.
    Optional for backward compatibility with the existing web client.
    Mobile sends this explicitly; the backend falls back to server time
    when older clients omit it.
  */
  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  /*
    Client-generated idempotency key.
    Mobile will generate this once for the operation and reuse the same value
    for every retry of that same create request.
  */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientOperationId?: string;

  @IsOptional()
  @IsNumber()
  odometer?: number;

  @IsOptional()
  @IsNumber()
  stationCounter?: number;

  @IsOptional()
  @IsString()
  externalStationName?: string;

  @IsOptional()
  @IsString()
  invoiceNumber?: string;

  @IsOptional()
  @IsNumber()
  externalInvoiceAmount?: number;


  @IsOptional()
  @IsString()
  notes?: string;

  /*
    Operation photos are uploaded first and the operation request stores
    only their Supabase Storage metadata/paths. The service enforces the
    exact three required photo types for each operation type.
  */
  @IsArray()
  attachments!: OperationAttachmentDto[];

  /*
    TEMPORARY TESTING FIELDS ONLY.
    Use these only until the Operations endpoint is connected to the real AuthGuard/current user.
    Production rule: backend must take the user from the authenticated request, not from the body.
  */
  @IsOptional()
  @IsString()
  requestedByUserId?: string;

  @IsOptional()
  @IsString()
  requestedByName?: string;

  @IsOptional()
  @IsString()
  requestedByRole?: string;

  @IsOptional()
  @IsString()
  companyId?: string;
}
