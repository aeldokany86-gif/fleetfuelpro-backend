import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";

import { AuthGuard } from "@nestjs/passport";

import { ProjectsService } from "./projects.service";

import { CreateProjectDto } from "./dto/create-project.dto";
import { UpdateProjectDto } from "./dto/update-project.dto";

@Controller("projects")
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  create(
    @Body()
    createProjectDto: CreateProjectDto,
  ) {
    return this.projectsService.create(createProjectDto);
  }

  @UseGuards(AuthGuard("jwt"))
  @Post("bootstrap-first-project")
  createBootstrapFirstProject(
    @Body()
    createProjectDto: CreateProjectDto,
    @Req()
    req: any,
  ) {
    return this.projectsService.createBootstrapFirstProject(
      createProjectDto,
      req.user.userId,
      req.user.companyId,
      req.user.roleName,
    );
  }


  @Get()
  findAll(
    @Query("companyId")
    companyId?: string,
  ) {
    return this.projectsService.findAll(companyId);
  }

  @Get("report/master")
  getProjectsMasterReport(
    @Query("companyId") companyId?: string,
    @Query("projectId") projectId?: string,
    @Query("status") status?: string,
  ) {
    return this.projectsService.getProjectsMasterReport({
      companyId,
      projectId,
      status,
    });
  }

  @Get("report/fuel-price-history")
  getProjectsFuelPriceHistoryReport(
    @Query("companyId") companyId?: string,
    @Query("projectId") projectId?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
  ) {
    return this.projectsService.getProjectsFuelPriceHistoryReport({
      companyId,
      projectId,
      dateFrom,
      dateTo,
    });
  }

  @Get(":id")
  findOne(
    @Param("id")
    id: string,
  ) {
    return this.projectsService.findOne(id);
  }

  @Patch(":id")
  update(
    @Param("id")
    id: string,

    @Body()
    updateProjectDto: UpdateProjectDto,
  ) {
    return this.projectsService.update(id, updateProjectDto);
  }

  @Patch(":id/manager")
  assignManager(
    @Param("id")
    id: string,

    @Body()
    body: {
      managerUserId: string;
    },
  ) {
    return this.projectsService.assignProjectManager(id, body.managerUserId);
  }

  @Post(":id/update-fuel-price")
  updateFuelPrice(
    @Param("id")
    id: string,

    @Body()
    body: {
      pricePerLiter?: number;
      basePricePerLiter?: number;
      transportCostPerLiter?: number;
      vatRate?: number;
      effectiveFrom?: string;
      reason?: string;
      createdByUserId?: string;
    },
  ) {
    return this.projectsService.updateFuelPrice(id, body);
  }

  @Get(":id/fuel-price-history")
  getFuelPriceHistory(
    @Param("id")
    id: string,
  ) {
    return this.projectsService.getFuelPriceHistory(id);
  }

  @Get(":id/effective-fuel-price")
  getEffectiveFuelPrice(
    @Param("id")
    id: string,

    @Query("operationDate")
    operationDate?: string,
  ) {
    return this.projectsService.getEffectiveFuelPrice(id, operationDate);
  }

  @Delete(":id")
  remove(
    @Param("id")
    id: string,
  ) {
    return this.projectsService.remove(id);
  }
}
