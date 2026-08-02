import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProjectDto {
  @IsString()
  @MaxLength(100)
  companyId: string;

  @IsString()
  @MaxLength(50)
  code: string;

  @IsString()
  @MaxLength(150)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  initialFuelPrice?: number;

  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  initialBasePricePerLiter?: number;

  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  initialTransportCostPerLiter?: number;

  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  initialVatRate?: number;
}
