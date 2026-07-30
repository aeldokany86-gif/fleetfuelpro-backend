import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  getHello(): string {
    return 'Hello World!';
  }

  async dbBenchmark() {
    const startedAt = Date.now();

    const queryStartedAt = Date.now();

    const projectCount = await this.prisma.project.count();

    const queryTimeMs = Date.now() - queryStartedAt;
    const totalTimeMs = Date.now() - startedAt;

    return {
      success: true,
      projectCount,
      queryTimeMs,
      totalTimeMs,
      serverTime: new Date(),
    };
  }
}