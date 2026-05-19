export class CreateUserDto {
  fullName: string;
  email: string;
  phone?: string;
  password: string;
  roleId: string;

  // Required when Platform User creates a user for a specific company.
  // Ignored for normal Admin users; backend will force Admin company scope.
  companyId?: string;
}
