import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';

import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { EmployeeCreationDomainService } from './employee-creation-domain.service';

@Module({
  imports: [
    PrismaModule,
  ],

  controllers: [
    EmployeesController,
  ],

  providers: [
    EmployeesService,
    EmployeeCreationDomainService,
  ],

  exports: [
    EmployeesService,
    EmployeeCreationDomainService,
  ],
})
export class EmployeesModule {}