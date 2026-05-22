import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: [
      'http://localhost:3000',
      'https://fleetfuelpro.vercel.app',
      'https://fleet-fuel-9kuwwpqyl-aeldokany86-gifs-projects.vercel.app',
    ],
    credentials: true,
  });

  await app.listen(4000);
}

bootstrap();