import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { ProjectsService } from './projects.service';

import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
  ) {}

  @Post()
  create(
    @Body()
    createProjectDto: CreateProjectDto,
  ) {
    return this.projectsService.create(
      createProjectDto,
    );
  }

  @Get()
  findAll(
    @Query('companyId')
    companyId?: string,
  ) {
    return this.projectsService.findAll(
      companyId,
    );
  }

  @Get(':id')
  findOne(
    @Param('id')
    id: string,
  ) {
    return this.projectsService.findOne(
      id,
    );
  }

  @Patch(':id')
  update(
    @Param('id')
    id: string,

    @Body()
    updateProjectDto: UpdateProjectDto,
  ) {
    return this.projectsService.update(
      id,
      updateProjectDto,
    );
  }

  @Patch(':id/manager')
  assignManager(
    @Param('id')
    id: string,

    @Body()
    body: {
      managerUserId: string;
      requestedByUserId?: string;
    },
  ) {
    return this.projectsService.assignProjectManager(
      id,
      body.managerUserId,
      body.requestedByUserId,
    );
  }

  @Delete(':id')
  remove(
    @Param('id')
    id: string,
  ) {
    return this.projectsService.remove(
      id,
    );
  }
}