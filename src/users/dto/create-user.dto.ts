export class CreateUserDto {
  // Company employee number / badge number.
  // Required for all company users and Platform Console users.
  // This value is entered by the company and must match an existing Team/Employee record.
  employeeId: string;

  // Optional technical shortcut when creating a user from the Team Linked button.
  linkedEmployeeId?: string;

  // Can be auto-filled from linked Employee if omitted.
  fullName?: string;

  // Email is mainly for Platform Console login, invitations, password reset and notifications.
  // Company users can login by employeeId, so email can be optional.
  email?: string;

  phone?: string;
  password: string;
  roleId: string;

  // Required when Platform User creates a user for a specific company.
  // Ignored for normal Admin users; backend will force Admin company scope.
  companyId?: string;
}
