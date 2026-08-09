import { Module } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { ProjectCreationDomainService } from './project-creation-domain.service';

@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectCreationDomainService],
})
export class ProjectsModule {}
