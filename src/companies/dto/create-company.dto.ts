export class CreateCompanyDto {
  name: string;
  code: string;
  country?: string;
  currency?: string;
  timezone?: string;
  language?: string;
}