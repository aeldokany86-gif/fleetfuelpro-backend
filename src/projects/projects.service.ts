// PROJECTS REPORT TERMINOLOGY VERSION: ENDED_STATUS_V2
// Expected master summary field: endedProjects (deletedProjects was removed).
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";

import { CreateProjectDto } from "./dto/create-project.dto";
import { UpdateProjectDto } from "./dto/update-project.dto";

@Injectable()
export class ProjectsService {
  constructor(private prisma: PrismaService) {}

  private normalizeCode(code: string) {
    return String(code || "")
      .trim()
      .toUpperCase();
  }

  private normalizeRoleName(roleName: string) {
    return String(roleName || "")
      .trim()
      .toUpperCase()
      .replace(/[\s_-]+/g, "");
  }

  private isAdminRole(roleName: string) {
    const normalized = this.normalizeRoleName(roleName);
    return (
      normalized === "ADMIN" ||
      normalized === "PLATFORMADMIN" ||
      normalized === "PLATFORMUSER"
    );
  }

  private roundPrice(value: number) {
    return Math.round((Number(value) + Number.EPSILON) * 1_000_000) / 1_000_000;
  }

  private resolveFuelPriceComponents(data: {
    pricePerLiter?: number;
    basePricePerLiter?: number;
    transportCostPerLiter?: number;
    vatRate?: number;
  }) {
    const hasComponentPricing = data.basePricePerLiter !== undefined;

    if (!hasComponentPricing) {
      const legacyPrice = Number(data.pricePerLiter);

      if (!Number.isFinite(legacyPrice) || legacyPrice <= 0) {
        throw new BadRequestException(
          "Price per liter must be greater than zero",
        );
      }

      return {
        isLegacy: true,
        basePricePerLiter: null,
        transportCostPerLiter: null,
        vatRate: null,
        vatAmountPerLiter: null,
        netPricePerLiter: this.roundPrice(legacyPrice),
        grossPricePerLiter: null,
      };
    }

    const basePricePerLiter = Number(data.basePricePerLiter);
    const transportCostPerLiter = Number(data.transportCostPerLiter ?? 0);
    const vatRate = Number(data.vatRate ?? 0);

    if (!Number.isFinite(basePricePerLiter) || basePricePerLiter <= 0) {
      throw new BadRequestException(
        "Base fuel price per liter must be greater than zero",
      );
    }

    if (!Number.isFinite(transportCostPerLiter) || transportCostPerLiter < 0) {
      throw new BadRequestException(
        "Transport cost per liter cannot be negative",
      );
    }

    if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100) {
      throw new BadRequestException("VAT rate must be between 0 and 100");
    }

    const netPricePerLiter = this.roundPrice(
      basePricePerLiter + transportCostPerLiter,
    );
    const vatAmountPerLiter = this.roundPrice(
      netPricePerLiter * (vatRate / 100),
    );

    return {
      isLegacy: false,
      basePricePerLiter: this.roundPrice(basePricePerLiter),
      transportCostPerLiter: this.roundPrice(transportCostPerLiter),
      vatRate: this.roundPrice(vatRate),
      vatAmountPerLiter,
      netPricePerLiter,
      grossPricePerLiter: this.roundPrice(netPricePerLiter + vatAmountPerLiter),
    };
  }

  private applyEffectiveCurrentPrice(project: any) {
    const { fuelPriceHistory = [], ...projectData } = project || {};
    const effectivePrice = fuelPriceHistory[0];

    if (!effectivePrice) return projectData;

    return {
      ...projectData,
      currentFuelPrice: effectivePrice.pricePerLiter,
      currentBaseFuelPrice: effectivePrice.basePricePerLiter,
      currentTransportCostPerLiter: effectivePrice.transportCost,
      currentVatRate: effectivePrice.vatRate,
      currentGrossFuelPrice: effectivePrice.grossPricePerLiter,
      fuelPriceCurrency: effectivePrice.currency,
      fuelPriceEffectiveFrom: effectivePrice.effectiveFrom,
    };
  }

  async create(createProjectDto: CreateProjectDto) {
    const company = await this.prisma.company.findFirst({
      where: {
        id: createProjectDto.companyId,
        deletedAt: null,
      },
    });

    if (!company) {
      throw new BadRequestException("Company not found");
    }

    const projectCode = this.normalizeCode(createProjectDto.code);

    const existingProject = await this.prisma.project.findFirst({
      where: {
        companyId: createProjectDto.companyId,
        code: projectCode,
      },
    });

    if (existingProject) {
      if (existingProject.deletedAt) {
        throw new BadRequestException(
          "This Project ID was previously used and cannot be reused",
        );
      }

      throw new BadRequestException(
        "Project code already exists in this company",
      );
    }

    const initialPricing = this.resolveFuelPriceComponents({
      pricePerLiter: createProjectDto.initialFuelPrice,
      basePricePerLiter: createProjectDto.initialBasePricePerLiter,
      transportCostPerLiter: createProjectDto.initialTransportCostPerLiter,
      vatRate: createProjectDto.initialVatRate,
    });

    const effectiveFrom = new Date();

    const createdProject = await this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          companyId: createProjectDto.companyId,
          code: projectCode,
          name: createProjectDto.name?.trim(),
          location: createProjectDto.location?.trim() || null,
          description: createProjectDto.description?.trim() || null,
          isActive: createProjectDto.isActive ?? true,
          currentFuelPrice: initialPricing.netPricePerLiter,
          currentBaseFuelPrice: initialPricing.basePricePerLiter,
          currentTransportCostPerLiter: initialPricing.transportCostPerLiter,
          currentVatRate: initialPricing.vatRate,
          currentGrossFuelPrice: initialPricing.grossPricePerLiter,
          fuelPriceCurrency: company.currency || "SAR",
          fuelPriceEffectiveFrom: effectiveFrom,
        },
        include: {
          company: {
            select: {
              id: true,
              name: true,
              code: true,
            },
          },
          projectManager: {
            select: {
              id: true,
              fullName: true,
              email: true,
              isActive: true,
            },
          },
        },
      });

      await tx.projectFuelPriceHistory.create({
        data: {
          projectId: project.id,
          companyId: project.companyId,
          country: company.country || "Unknown",
          currency: company.currency || "SAR",
          basePricePerLiter: initialPricing.basePricePerLiter,
          transportCost: initialPricing.transportCostPerLiter,
          pricePerLiter: initialPricing.netPricePerLiter,
          vatRate: initialPricing.vatRate,
          vatAmountPerLiter: initialPricing.vatAmountPerLiter,
          grossPricePerLiter: initialPricing.grossPricePerLiter,
          effectiveFrom,
          reason: initialPricing.isLegacy
            ? "Initial project fuel price (legacy combined price)"
            : "Initial project fuel price",
          createdByUserId: null,
        },
      });

      return project;
    });

    return createdProject;
  }

  async findAll(companyId?: string) {
    const now = new Date();
    const projects = await this.prisma.project.findMany({
      where: {
        deletedAt: null,
        ...(companyId ? { companyId } : {}),
      },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        projectManager: {
          select: {
            id: true,
            fullName: true,
            email: true,
            isActive: true,
          },
        },
        fuelPriceHistory: {
          where: {
            effectiveFrom: { lte: now },
          },
          orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
          take: 1,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return projects.map((project) => this.applyEffectiveCurrentPrice(project));
  }

  async getProjectsMasterReport(filters: {
    companyId?: string;
    projectId?: string;
    status?: string;
  }) {
    const companyId = String(filters.companyId || "").trim();
    if (!companyId) {
      throw new BadRequestException("Company ID is required");
    }

    const status = String(filters.status || "")
      .trim()
      .toUpperCase();
    if (
      status &&
      !["ACTIVE", "INACTIVE", "ENDED", "DELETED"].includes(status)
    ) {
      throw new BadRequestException(
        "Project status must be ACTIVE, INACTIVE, or ENDED",
      );
    }

    const projectWhere = {
      companyId,
      ...(filters.projectId ? { id: filters.projectId } : {}),
      ...(status === "ENDED" || status === "DELETED"
        ? { deletedAt: { not: null } }
        : status
          ? { deletedAt: null, isActive: status === "ACTIVE" }
          : {}),
    };

    const now = new Date();
    const projects = await this.prisma.project.findMany({
      where: projectWhere,
      include: {
        company: { select: { id: true, name: true, code: true } },
        projectManager: {
          select: { id: true, fullName: true, email: true, isActive: true },
        },
        fuelPriceHistory: {
          where: { effectiveFrom: { lte: now } },
          orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
          take: 1,
        },
        _count: {
          select: {
            assets: { where: { deletedAt: null } },
            stations: { where: { deletedAt: null } },
            employees: { where: { deletedAt: null } },
          },
        },
      },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    });

    const projectIds = projects.map((project) => project.id);
    const initialPriceRows = projectIds.length
      ? await this.prisma.projectFuelPriceHistory.findMany({
          where: {
            projectId: { in: projectIds },
            reason: { startsWith: "Initial project fuel price" },
          },
          select: { projectId: true, effectiveFrom: true },
          orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }],
        })
      : [];

    const projectStartById = new Map<string, Date>();
    for (const row of initialPriceRows) {
      if (!projectStartById.has(row.projectId)) {
        projectStartById.set(row.projectId, row.effectiveFrom);
      }
    }

    const operationGroups = projectIds.length
      ? await this.prisma.operation.groupBy({
          by: ["projectIdAtOperation"],
          where: {
            companyId,
            projectIdAtOperation: { in: projectIds },
            status: "COMPLETED",
            type: { in: ["DIRECT_REFUEL", "EXTERNAL_DIRECT_REFUEL"] },
          },
          _count: { _all: true },
          _sum: {
            quantity: true,
            totalCostAtOperation: true,
          },
        })
      : [];

    const operationByProject = new Map(
      operationGroups.map((row) => [row.projectIdAtOperation, row]),
    );

    const rows = projects.map((rawProject) => {
      const project = this.applyEffectiveCurrentPrice(rawProject);
      const operations = operationByProject.get(project.id);
      return {
        projectId: project.id,
        projectCode: project.code,
        projectName: project.name,
        location: project.location,
        description: project.description,
        status: project.deletedAt
          ? "ENDED"
          : project.isActive
            ? "ACTIVE"
            : "INACTIVE",
        managerId: project.projectManager?.id || null,
        managerName: project.projectManager?.fullName || null,
        managerEmail: project.projectManager?.email || null,
        basePricePerLiter: project.currentBaseFuelPrice,
        transportCostPerLiter: project.currentTransportCostPerLiter,
        operationalPricePerLiter: project.currentFuelPrice,
        vatRate: project.currentVatRate,
        grossPricePerLiter: project.currentGrossFuelPrice,
        currency: project.fuelPriceCurrency,
        // Compatibility alias kept for existing frontend consumers.
        priceEffectiveFrom: project.fuelPriceEffectiveFrom,
        currentPriceEffectiveFrom: project.fuelPriceEffectiveFrom,
        latestPriceEffectiveFrom: project.fuelPriceEffectiveFrom,
        assetsCount: project._count.assets,
        stationsCount: project._count.stations,
        employeesCount: project._count.employees,
        refuelOperationsCount: operations?._count?._all || 0,
        consumedQuantity: operations?._sum?.quantity || 0,
        totalCost: operations?._sum?.totalCostAtOperation || 0,
        createdAt: project.createdAt,
        projectStartDate:
          projectStartById.get(project.id) || project.createdAt,
        projectEndDate: project.deletedAt,
      };
    });

    return {
      generatedAt: new Date(),
      summary: {
        totalProjects: rows.length,
        activeProjects: rows.filter((row) => row.status === "ACTIVE").length,
        inactiveProjects: rows.filter((row) => row.status === "INACTIVE")
          .length,
        endedProjects: rows.filter((row) => row.status === "ENDED").length,
        totalAssets: rows.reduce((sum, row) => sum + row.assetsCount, 0),
        totalStations: rows.reduce((sum, row) => sum + row.stationsCount, 0),
        totalEmployees: rows.reduce((sum, row) => sum + row.employeesCount, 0),
        consumedQuantity: rows.reduce(
          (sum, row) => sum + row.consumedQuantity,
          0,
        ),
        totalCost: rows.reduce((sum, row) => sum + row.totalCost, 0),
      },
      rows,
    };
  }

  async getProjectsFuelPriceHistoryReport(filters: {
    companyId?: string;
    projectId?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const companyId = String(filters.companyId || "").trim();
    if (!companyId) {
      throw new BadRequestException("Company ID is required");
    }

    const effectiveFrom: { gte?: Date; lte?: Date } = {};
    if (filters.dateFrom) {
      const value = new Date(`${filters.dateFrom}T00:00:00`);
      if (Number.isNaN(value.getTime()))
        throw new BadRequestException("Date from is invalid");
      effectiveFrom.gte = value;
    }
    if (filters.dateTo) {
      const value = new Date(`${filters.dateTo}T23:59:59.999`);
      if (Number.isNaN(value.getTime()))
        throw new BadRequestException("Date to is invalid");
      effectiveFrom.lte = value;
    }

    const history = await this.prisma.projectFuelPriceHistory.findMany({
      where: {
        companyId,
        ...(filters.projectId ? { projectId: filters.projectId } : {}),
        ...(Object.keys(effectiveFrom).length ? { effectiveFrom } : {}),
      },
      include: {
        project: { select: { id: true, code: true, name: true } },
        createdBy: { select: { id: true, fullName: true, email: true } },
        _count: { select: { operations: true } },
      },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
    });

    const rows = history.map((row) => ({
      priceHistoryId: row.id,
      projectId: row.projectId,
      projectCode: row.project.code,
      projectName: row.project.name,
      effectiveFrom: row.effectiveFrom,
      priceEffectiveFrom: row.effectiveFrom,
      basePricePerLiter: row.basePricePerLiter,
      transportCostPerLiter: row.transportCost,
      operationalPricePerLiter: row.pricePerLiter,
      vatRate: row.vatRate,
      vatAmountPerLiter: row.vatAmountPerLiter,
      grossPricePerLiter: row.grossPricePerLiter,
      currency: row.currency,
      reason: row.reason,
      changedById: row.createdBy?.id || null,
      changedByName: row.createdBy?.fullName || null,
      changedByEmail: row.createdBy?.email || null,
      pricedOperationsCount: row._count.operations,
      createdAt: row.createdAt,
    }));

    return {
      generatedAt: new Date(),
      summary: {
        priceChanges: rows.length,
        affectedProjects: new Set(rows.map((row) => row.projectId)).size,
        pricedOperations: rows.reduce(
          (sum, row) => sum + row.pricedOperationsCount,
          0,
        ),
      },
      rows,
    };
  }

  async findOne(id: string) {
    const now = new Date();
    const project = await this.prisma.project.findFirst({
      where: {
        id,
        deletedAt: null,
      },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        projectManager: {
          select: {
            id: true,
            fullName: true,
            email: true,
            isActive: true,
          },
        },
        fuelPriceHistory: {
          where: {
            effectiveFrom: { lte: now },
          },
          orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
          take: 1,
        },
      },
    });

    if (!project) {
      throw new NotFoundException("Project not found");
    }

    return this.applyEffectiveCurrentPrice(project);
  }

  async update(id: string, updateProjectDto: UpdateProjectDto) {
    const existingProject = await this.prisma.project.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!existingProject) {
      throw new NotFoundException("Project not found");
    }

    const nextCompanyId =
      updateProjectDto.companyId || existingProject.companyId;

    const nextCode = updateProjectDto.code
      ? this.normalizeCode(updateProjectDto.code)
      : existingProject.code;

    if (
      nextCompanyId !== existingProject.companyId ||
      nextCode !== existingProject.code
    ) {
      const duplicateProject = await this.prisma.project.findFirst({
        where: {
          companyId: nextCompanyId,
          code: nextCode,
          NOT: {
            id,
          },
        },
      });

      if (duplicateProject) {
        if (duplicateProject.deletedAt) {
          throw new BadRequestException(
            "This Project ID was previously used and cannot be reused",
          );
        }

        throw new BadRequestException(
          "Project code already exists in this company",
        );
      }
    }

    return this.prisma.project.update({
      where: { id },
      data: {
        ...(updateProjectDto.companyId !== undefined
          ? {
              companyId: updateProjectDto.companyId,
            }
          : {}),

        ...(updateProjectDto.code !== undefined
          ? {
              code: nextCode,
            }
          : {}),

        ...(updateProjectDto.name !== undefined
          ? {
              name: updateProjectDto.name.trim(),
            }
          : {}),

        ...(updateProjectDto.location !== undefined
          ? {
              location: updateProjectDto.location?.trim() || null,
            }
          : {}),

        ...(updateProjectDto.description !== undefined
          ? {
              description: updateProjectDto.description?.trim() || null,
            }
          : {}),

        ...(updateProjectDto.isActive !== undefined
          ? {
              isActive: updateProjectDto.isActive,
            }
          : {}),
      },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        projectManager: {
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

  async assignProjectManager(
    projectId: string,
    managerUserId: string,
    requestedByUserId?: string,
  ) {
    if (!managerUserId) {
      throw new BadRequestException("Manager user is required");
    }

    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        deletedAt: null,
      },
    });

    if (!project) {
      throw new NotFoundException("Project not found");
    }

    if (requestedByUserId) {
      const requester = await this.prisma.user.findFirst({
        where: {
          id: requestedByUserId,
          deletedAt: null,
          isActive: true,
          companyId: project.companyId,
        },
        include: {
          role: true,
        },
      });

      if (!requester || !this.isAdminRole(requester.role?.name || "")) {
        throw new BadRequestException(
          "Only Admin can approve Project Manager assignment",
        );
      }
    }

    const manager = await this.prisma.user.findFirst({
      where: {
        id: managerUserId,
        deletedAt: null,
        isActive: true,
        companyId: project.companyId,
      },
      include: {
        role: true,
        linkedEmployee: {
          select: {
            id: true,
            employeeId: true,
            name: true,
            status: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!manager) {
      throw new BadRequestException("Manager user not found");
    }

    if (this.normalizeRoleName(manager.role?.name) !== "MANAGER") {
      throw new BadRequestException("Assigned user must have Manager role");
    }

    if (
      manager.linkedEmployee &&
      (manager.linkedEmployee.deletedAt ||
        manager.linkedEmployee.status === "RETIRED_RESIGNED")
    ) {
      throw new BadRequestException(
        "Assigned manager employee profile is not active",
      );
    }

    return this.prisma.project.update({
      where: {
        id: projectId,
      },
      data: {
        projectManagerId: managerUserId,
      },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        projectManager: {
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

  async updateFuelPrice(
    projectId: string,
    data: {
      pricePerLiter?: number;
      basePricePerLiter?: number;
      transportCostPerLiter?: number;
      vatRate?: number;
      effectiveFrom?: string;
      reason?: string;
      createdByUserId?: string;
    },
  ) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        deletedAt: null,
      },
      include: {
        company: true,
      },
    });

    if (!project) {
      throw new NotFoundException("Project not found");
    }

    const pricing = this.resolveFuelPriceComponents(data);

    const effectiveFrom = data.effectiveFrom
      ? new Date(data.effectiveFrom)
      : new Date();

    if (Number.isNaN(effectiveFrom.getTime())) {
      throw new BadRequestException("Effective date is invalid");
    }

    const initialPrice = await this.prisma.projectFuelPriceHistory.findFirst({
      where: {
        projectId: project.id,
        reason: { startsWith: "Initial project fuel price" },
      },
      select: { effectiveFrom: true },
      orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }],
    });

    const projectStartDate = initialPrice?.effectiveFrom || project.createdAt;

    if (effectiveFrom.getTime() < projectStartDate.getTime()) {
      throw new BadRequestException(
        `Fuel price cannot be updated with a date before project creation (${projectStartDate.toISOString()})`,
      );
    }

    return this.prisma.$transaction(
      async (tx) => {
        const history = await tx.projectFuelPriceHistory.create({
          data: {
            projectId: project.id,
            companyId: project.companyId,
            country: project.company?.country || "Unknown",
            currency: project.company?.currency || "SAR",
            basePricePerLiter: pricing.basePricePerLiter,
            transportCost: pricing.transportCostPerLiter,
            pricePerLiter: pricing.netPricePerLiter,
            vatRate: pricing.vatRate,
            vatAmountPerLiter: pricing.vatAmountPerLiter,
            grossPricePerLiter: pricing.grossPricePerLiter,
            effectiveFrom,
            reason:
              data.reason?.trim() ||
              (pricing.isLegacy
                ? "Project fuel price update (legacy combined price)"
                : null),
            createdByUserId: data.createdByUserId || null,
          },
          include: {
            project: true,
            company: true,
            createdBy: true,
          },
        });

        const [latestPrice, nextPrice] = await Promise.all([
          tx.projectFuelPriceHistory.findFirst({
            where: {
              projectId: project.id,
              effectiveFrom: {
                lte: new Date(),
              },
            },
            orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
          }),
          tx.projectFuelPriceHistory.findFirst({
            where: {
              projectId: project.id,
              effectiveFrom: {
                gt: effectiveFrom,
              },
            },
            orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }],
          }),
        ]);

        await tx.project.update({
          where: {
            id: project.id,
          },
          data: {
            currentFuelPrice: latestPrice?.pricePerLiter || 0,
            currentBaseFuelPrice: latestPrice?.basePricePerLiter ?? null,
            currentTransportCostPerLiter: latestPrice?.transportCost ?? null,
            currentVatRate: latestPrice?.vatRate ?? null,
            currentGrossFuelPrice: latestPrice?.grossPricePerLiter ?? null,
            fuelPriceEffectiveFrom: latestPrice?.effectiveFrom || new Date(),
          },
        });

        const operationsToReprice = await tx.operation.findMany({
          where: {
            companyId: project.companyId,
            projectIdAtOperation: project.id,
            status: "COMPLETED",
            type: {
              not: "EXTERNAL_DIRECT_REFUEL",
            },
            completedAt: {
              gte: effectiveFrom,
              ...(nextPrice?.effectiveFrom
                ? { lt: nextPrice.effectiveFrom }
                : {}),
            },
          },
          select: {
            id: true,
            quantity: true,
          },
        });

        const repricedOperations = operationsToReprice.length;

        if (repricedOperations > 0) {
          for (const operation of operationsToReprice) {
            await tx.operation.update({
              where: {
                id: operation.id,
              },
              data: {
                fuelPriceHistoryId: history.id,
                pricePerLiterAtOperation: pricing.netPricePerLiter,
                totalCostAtOperation:
                  Number(operation.quantity || 0) * pricing.netPricePerLiter,
                basePricePerLiterAtOperation: pricing.basePricePerLiter,
                transportCostPerLiterAtOperation: pricing.transportCostPerLiter,
                vatRateAtOperation: pricing.vatRate,
                vatAmountPerLiterAtOperation: pricing.vatAmountPerLiter,
                grossPricePerLiterAtOperation: pricing.grossPricePerLiter,
                grossTotalCostAtOperation:
                  pricing.grossPricePerLiter == null
                    ? null
                    : Number(operation.quantity || 0) *
                      pricing.grossPricePerLiter,
              },
            });
          }
        }

        return {
          ...history,
          repricedOperations,
          repricedFrom: effectiveFrom,
          repricedUntil: nextPrice?.effectiveFrom || null,
        };
      },
      {
        maxWait: 10000,
        timeout: 20000,
      },
    );
  }

  async getFuelPriceHistory(projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        deletedAt: null,
      },
    });

    if (!project) {
      throw new NotFoundException("Project not found");
    }

    return this.prisma.projectFuelPriceHistory.findMany({
      where: {
        projectId,
      },
      include: {
        company: true,
        project: true,
        createdBy: true,
      },
      orderBy: {
        effectiveFrom: "desc",
      },
    });
  }

  async getEffectiveFuelPrice(projectId: string, operationDate?: string) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        deletedAt: null,
      },
    });

    if (!project) {
      throw new NotFoundException("Project not found");
    }

    const targetDate = operationDate ? new Date(operationDate) : new Date();

    const price = await this.prisma.projectFuelPriceHistory.findFirst({
      where: {
        projectId,
        effectiveFrom: {
          lte: targetDate,
        },
      },
      orderBy: {
        effectiveFrom: "desc",
      },
    });

    if (!price) {
      throw new NotFoundException("No fuel price found for this date");
    }

    return price;
  }
  async remove(id: string) {
    const existingProject = await this.prisma.project.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!existingProject) {
      throw new NotFoundException("Project not found");
    }

    return this.prisma.project.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        isActive: false,
      },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        projectManager: {
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
