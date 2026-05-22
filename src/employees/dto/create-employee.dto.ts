export class CreateEmployeeDto {
  companyId: string;

  employeeId: string;

  name: string;

  phone?: string;

  email?: string;

  // REQUIRED
  projectId: string;

  linkedUserId?: string;

  jobTitle?: string;

  status?:
    | 'ON_DUTY'
    | 'VACATION'
    | 'RETIRED_RESIGNED';
}