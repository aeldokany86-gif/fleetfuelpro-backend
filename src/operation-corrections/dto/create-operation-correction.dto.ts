import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateOperationCorrectionDto {
  @IsString()
  @IsNotEmpty()
  operationId!: string;

  /**
   * Allowed values:
   * assetId, sourceStationId, destinationStationId, quantity, odometer,
   * stationCounter, externalStationName, invoiceNumber, totalCostAtOperation, notes
   */
  @IsString()
  @IsNotEmpty()
  fieldName!: string;

  /** New value for the corrected field. Keep IDs as backend IDs, not display codes. */
  newValue!: unknown;

  /** Required business reason for audit and manager approval. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
