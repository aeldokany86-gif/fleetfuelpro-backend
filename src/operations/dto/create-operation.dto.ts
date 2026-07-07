import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
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

  @IsNumber()
  @IsPositive()
  quantity!: number;

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
  @IsString()
  notes?: string;

  /*
    Optional until Supabase Storage upload is enabled.
    Later this will store paths only, not Base64.
  */
  @IsOptional()
  attachments?: Record<string, unknown>;

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
