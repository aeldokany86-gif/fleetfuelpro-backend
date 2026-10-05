import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { TelemetryTransport } from '@prisma/client';
import { connect, MqttClient } from 'mqtt';
import { TelemetryAdapterRegistry } from '../adapters/telemetry-adapter.registry';
import { TelemetryDeviceService } from '../telemetry-device.service';
import { TelemetryIngestionService } from '../telemetry-ingestion.service';

@Injectable()
export class MqttTelemetrySubscriberService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(MqttTelemetrySubscriberService.name);
  private client: MqttClient | null = null;

  constructor(
    private readonly telemetryDeviceService: TelemetryDeviceService,
    private readonly telemetryIngestionService: TelemetryIngestionService,
    private readonly telemetryAdapterRegistry: TelemetryAdapterRegistry,
  ) {}

  onModuleInit() {
    const enabled =
      String(process.env.MQTT_ENABLED || '').trim().toLowerCase() === 'true';

    if (!enabled) {
      this.logger.log('MQTT telemetry subscriber is disabled.');
      return;
    }

    const host = String(process.env.MQTT_HOST || '').trim();
    const protocol =
      String(process.env.MQTT_PROTOCOL || 'mqtt')
        .trim()
        .toLowerCase() === 'mqtts'
        ? 'mqtts'
        : 'mqtt';
    const defaultPort = protocol === 'mqtts' ? 8883 : 1883;
    const port = Number(process.env.MQTT_PORT || defaultPort);
    const username = String(process.env.MQTT_USERNAME || '').trim();
    const password = String(process.env.MQTT_PASSWORD || '');
    const topic = String(
      process.env.MQTT_TOPIC_TELEMETRY || 'BCE/D',
    ).trim();

    if (!host) {
      this.logger.error('MQTT_HOST is not configured.');
      return;
    }

    if (!username) {
      this.logger.error('MQTT_USERNAME is not configured.');
      return;
    }

    if (!password) {
      this.logger.error('MQTT_PASSWORD is not configured.');
      return;
    }

    if (!Number.isFinite(port) || port <= 0) {
      this.logger.error('MQTT_PORT is invalid.');
      return;
    }

    if (!topic) {
      this.logger.error('MQTT_TOPIC_TELEMETRY is not configured.');
      return;
    }

    this.logger.log(
      `Connecting to MQTT broker ${host}:${port} using ${protocol.toUpperCase()}...`,
    );

    this.client = connect({
      protocol,
      host,
      port,
      username,
      password,
      clientId: `ffp-backend-${process.pid}`,
      clean: true,
      reconnectPeriod: 4000,
      connectTimeout: 10000,
      keepalive: 60,
      ...(protocol === 'mqtts' ? { rejectUnauthorized: true } : {}),
    });

    this.client.on('connect', () => {
      this.logger.log('Connected to MQTT broker.');

      this.client?.subscribe(topic, { qos: 0 }, (error) => {
        if (error) {
          this.logger.error(
            `Failed to subscribe to MQTT topic ${topic}: ${error.message}`,
          );
          return;
        }

        this.logger.log(`Subscribed to MQTT topic: ${topic}`);
      });
    });

    this.client.on('message', (receivedTopic, payload) => {
      this.logger.log(
        `MQTT message received | topic=${receivedTopic} | bytes=${payload.length}`,
      );

      void this.processXirgoTelemetry(receivedTopic, payload);
    });

    this.client.on('reconnect', () => {
      this.logger.warn('Reconnecting to MQTT broker...');
    });

    this.client.on('offline', () => {
      this.logger.warn('MQTT client is offline.');
    });

    this.client.on('error', (error) => {
      this.logger.error(`MQTT error: ${error.message}`);
    });

    this.client.on('close', () => {
      this.logger.warn('MQTT connection closed.');
    });
  }

  private async processXirgoTelemetry(topic: string, payload: Buffer) {
    try {
      const decoded = this.telemetryAdapterRegistry.decodeXirgoIotm(payload);
      const imei = String(decoded.imei || '').trim();

      if (!imei) {
        this.logger.warn(
          `Ignoring Xirgo MQTT message without IMEI | topic=${topic} | bytes=${payload.length}`,
        );
        return;
      }

      const device =
        await this.telemetryDeviceService.findActiveByVendorHardwareId(
          'XIRGO',
          imei,
        );

      if (!device) {
        this.logger.warn(
          `Ignoring telemetry from unregistered Xirgo device | topic=${topic}`,
        );
        return;
      }

      if (!device.assetId) {
        this.logger.warn(
          `Ignoring telemetry from Xirgo device that is not assigned to an asset | deviceId=${device.id}`,
        );
        return;
      }

      const result = await this.telemetryIngestionService.ingestXirgo({
        companyId: device.companyId,
        deviceId: device.id,
        transport: TelemetryTransport.MQTT,
        topic,
        payload: payload.toString('hex'),
        payloadEncoding: 'hex',
        decodedPayload: decoded,
        metadata: {
          source: 'mqtt-subscriber',
          vendor: 'XIRGO',
        },
      });

      this.logger.log(
        `Xirgo telemetry ingested | deviceId=${device.id} | assetId=${device.assetId} | readings=${result.readingCount} | status=${result.parseStatus}`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown MQTT ingestion error';

      this.logger.error(
        `Failed to process Xirgo MQTT telemetry | topic=${topic} | error=${message}`,
      );
    }
  }

  onApplicationShutdown() {
    if (!this.client) return;

    this.logger.log('Closing MQTT connection...');
    this.client.end(true);
    this.client = null;
  }
}
