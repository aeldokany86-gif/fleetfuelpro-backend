export class CreateEmployeeDto {
  companyId: string;

  employeeId: string;

  name: string;

  phone?: string;

  email?: string;

  // Required for normal employees.
  // Optional only for the one-time Platform bootstrap Admin employee.
  projectId?: string;

  linkedUserId?: string;

  jobTitle?: string;

  status?:
    | 'ON_DUTY'
    | 'VACATION'
    | 'RETIRED_RESIGNED';
}