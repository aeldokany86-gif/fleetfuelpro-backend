import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

export type ProjectFuelPricing = {
  isLegacy: boolean;
  basePricePerLiter: number | null;
  transportCostPerLiter: number | null;
  vatRate: number | null;
  vatAmountPerLiter: number | null;
  netPricePerLiter: number;
  grossPricePerLiter: number | null;
};

type ProjectCompanyContext = {
  country?: string | null;
  currency?: string | null;
};

type CreateProjectWithInitialPriceInput = {
  company: ProjectCompanyContext;
  companyId: string;
  projectCode: string;
  name: string;
  location?: string;
  description?: string;
  isActive?: boolean;
  initialPricing: ProjectFuelPricing;
  effectiveFrom: Date;
  createdByUserId?: string | null;
};

@Injectable()
export class ProjectCreationDomainService {
  normalizeCode(code: string) {
    return String(code || "")
      .trim()
      .toUpperCase();
  }

  private roundPrice(value: number) {
    return Math.round((Number(value) + Number.EPSILON) * 1_000_000) / 1_000_000;
  }

  resolveFuelPriceComponents(data: {
    pricePerLiter?: number;
    basePricePerLiter?: number;
    transportCostPerLiter?: number;
    vatRate?: number;
  }): ProjectFuelPricing {
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

  async createProjectWithInitialPrice(
    tx: Prisma.TransactionClient,
    input: CreateProjectWithInitialPriceInput,
  ) {
    const project = await tx.project.create({
      data: {
        companyId: input.companyId,
        code: input.projectCode,
        name: input.name?.trim(),
        location: input.location?.trim() || null,
        description: input.description?.trim() || null,
        isActive: input.isActive ?? true,
        currentFuelPrice: input.initialPricing.netPricePerLiter,
        currentBaseFuelPrice: input.initialPricing.basePricePerLiter,
        currentTransportCostPerLiter:
          input.initialPricing.transportCostPerLiter,
        currentVatRate: input.initialPricing.vatRate,
        currentGrossFuelPrice: input.initialPricing.grossPricePerLiter,
        fuelPriceCurrency: input.company.currency || "SAR",
        fuelPriceEffectiveFrom: input.effectiveFrom,
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
        country: input.company.country || "Unknown",
        currency: input.company.currency || "SAR",
        basePricePerLiter: input.initialPricing.basePricePerLiter,
        transportCost: input.initialPricing.transportCostPerLiter,
        pricePerLiter: input.initialPricing.netPricePerLiter,
        vatRate: input.initialPricing.vatRate,
        vatAmountPerLiter: input.initialPricing.vatAmountPerLiter,
        grossPricePerLiter: input.initialPricing.grossPricePerLiter,
        effectiveFrom: input.effectiveFrom,
        reason: input.initialPricing.isLegacy
          ? "Initial project fuel price (legacy combined price)"
          : "Initial project fuel price",
        createdByUserId: input.createdByUserId ?? null,
      },
    });

    return project;
  }
}
