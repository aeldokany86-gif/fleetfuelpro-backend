import 'dotenv/config';
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

  const port = Number(process.env.PORT) || 4000;
  await app.listen(port, '0.0.0.0');
}

bootstrap();