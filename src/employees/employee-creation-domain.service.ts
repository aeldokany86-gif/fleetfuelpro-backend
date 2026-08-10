import { Injectable } from '@nestjs/common';
import {
  EmployeeStatus,
  Prisma,
} from '@prisma/client';

type EmployeePersistenceClient = Pick<
  Prisma.TransactionClient,
  'employee'
>;

export type CreateEmployeePreparedInput = {
  companyId: string;
  employeeId: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  projectId?: string | null;
  linkedUserId?: string | null;
  jobTitle?: string | null;
  status?: EmployeeStatus;
  createdById?: string | null;
};

@Injectable()
export class EmployeeCreationDomainService {
  normalizeEmployeeId(employeeId?: string | null) {
    return String(employeeId || '')
      .trim()
      .toUpperCase();
  }

  normalizeProjectCode(projectCode?: string | null) {
    return String(projectCode || '')
      .trim()
      .toUpperCase();
  }

  normalizeOptionalText(value?: string | null) {
    const normalized = String(value || '').trim();
    return normalized || null;
  }

  async createEmployee(
    db: EmployeePersistenceClient,
    input: CreateEmployeePreparedInput,
  ) {
    return db.employee.create({
      data: {
        companyId: input.companyId,
        employeeId: this.normalizeEmployeeId(input.employeeId),
        name: String(input.name || '').trim(),
        phone: this.normalizeOptionalText(input.phone),
        email: this.normalizeOptionalText(input.email),
        projectId: input.projectId || null,
        linkedUserId: input.linkedUserId || null,
        jobTitle:
          this.normalizeOptionalText(input.jobTitle) ||
          'Operator',
        status:
          input.status ||
          EmployeeStatus.ON_DUTY,
        createdById: input.createdById || null,
      },
      include: {
        project: true,
        linkedUser: {
          select: {
            id: true,
            fullName: true,
            email: true,
            isActive: true,
          },
        },
      },
    });
  }
}
