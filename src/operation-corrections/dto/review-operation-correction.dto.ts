export class ReviewOperationCorrectionDto {
  /** APPROVE or REJECT */
  action!: 'APPROVE' | 'REJECT';
  note?: string;
}
