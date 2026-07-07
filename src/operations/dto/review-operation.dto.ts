import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum ReviewOperationActionDto {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export class ReviewOperationDto {
  @IsEnum(ReviewOperationActionDto)
  action!: ReviewOperationActionDto;

  @IsOptional()
  @IsString()
  note?: string;
}
