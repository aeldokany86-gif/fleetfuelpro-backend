import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { RolesModule } from './roles/roles.module';
import { CompaniesModule } from './companies/companies.module';
import { ProjectsModule } from './projects/projects.module';
import { EmployeesController } from './employees/employees.controller';
import { EmployeesService } from './employees/employees.service';
import { EmployeesModule } from './employees/employees.module';
import { EmployeeTransfersModule } from './employee-transfers/employee-transfers.module';
import { AssetsModule } from './assets/assets.module';
import { StationsModule } from './stations/stations.module';
import { OperationsModule } from './operations/operations.module';
import { OperationCorrectionsModule } from './operation-corrections/operation-corrections.module';
import { UploadsModule } from './uploads/uploads.module';
import { ImportsModule } from './imports/imports.module';

@Module({
  imports: [
    PrismaModule,
    UsersModule,
    AuthModule,
    RolesModule,
    CompaniesModule,
    ProjectsModule,
    EmployeesModule,
    EmployeeTransfersModule,
    AssetsModule,
    StationsModule,
    OperationsModule,
    OperationCorrectionsModule,
    UploadsModule,
    ImportsModule,
  ],
  controllers: [AppController, EmployeesController],
  providers: [AppService, EmployeesService],
})
export class AppModule {}
