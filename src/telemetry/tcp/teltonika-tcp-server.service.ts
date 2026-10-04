import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { TelemetryTransport } from '@prisma/client';
import { createServer, Server, Socket } from 'net';

import { TelemetryDeviceService } from '../telemetry-device.service';
import { TelemetryIngestionService } from '../telemetry-ingestion.service';
import { TeltonikaTcpFrameParser } from './teltonika-tcp-frame.parser';

type TeltonikaConnectionState = {
  buffer: Buffer;
  imei: string | null;
  device:
    | Awaited<
        ReturnType<TelemetryDeviceService['findActiveByVendorHardwareId']>
      >
    | null;
  processing: boolean;
};

@Injectable()
export class TeltonikaTcpServerService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(TeltonikaTcpServerService.name);
  private readonly parser = new TeltonikaTcpFrameParser();
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly telemetryDeviceService: TelemetryDeviceService,
    private readonly telemetryIngestionService: TelemetryIngestionService,
  ) {}

  onModuleInit() {
    const enabled =
      String(process.env.TELTONIKA_TCP_ENABLED || '')
        .trim()
        .toLowerCase() === 'true';

    if (!enabled) {
      this.logger.log('Teltonika TCP server is disabled.');
      return;
    }

    const host = String(process.env.TELTONIKA_TCP_HOST || '0.0.0.0').trim();
    const port = Number(process.env.TELTONIKA_TCP_PORT || 5027);

    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      this.logger.error('TELTONIKA_TCP_PORT is invalid.');
      return;
    }

    this.server = createServer((socket) => this.handleConnection(socket));

    this.server.on('error', (error) => {
      this.logger.error(`Teltonika TCP server error: ${error.message}`);
    });

    this.server.listen(port, host, () => {
      this.logger.log(`Teltonika TCP server listening on ${host}:${port}`);
    });
  }

  private handleConnection(socket: Socket) {
    this.sockets.add(socket);

    const remote = `${socket.remoteAddress || 'unknown'}:${socket.remotePort || 0}`;
    this.logger.log(`Teltonika TCP client connected | remote=${remote}`);

    const state: TeltonikaConnectionState = {
      buffer: Buffer.alloc(0),
      imei: null,
      device: null,
      processing: false,
    };

    socket.setKeepAlive(true, 60_000);

    socket.on('data', (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      void this.drain(socket, state);
    });

    socket.on('error', (error) => {
      this.logger.warn(
        `Teltonika TCP socket error | remote=${remote} | error=${error.message}`,
      );
    });

    socket.on('close', () => {
      this.sockets.delete(socket);
      this.logger.log(
        `Teltonika TCP client disconnected | remote=${remote}${
          state.imei ? ' | authenticated=true' : ''
        }`,
      );
    });
  }

  private async drain(socket: Socket, state: TeltonikaConnectionState) {
    if (state.processing || socket.destroyed) return;

    state.processing = true;

    try {
      while (!socket.destroyed) {
        if (!state.imei) {
          const parsedImei = this.parser.tryReadImei(state.buffer);
          if (!parsedImei) return;

          state.buffer = state.buffer.subarray(parsedImei.consumedBytes);

          const device =
            await this.telemetryDeviceService.findActiveByVendorHardwareId(
              'TELTONIKA',
              parsedImei.imei,
            );

          const protocol = String(device?.protocol || '').trim().toUpperCase();
          const transport = device?.transport ?? null;

          const accepted =
            !!device &&
            (!protocol || protocol === 'CODEC_8_EXTENDED') &&
            (!transport || transport === TelemetryTransport.TCP);

          socket.write(this.parser.buildImeiAck(accepted));

          if (!accepted || !device) {
            this.logger.warn(
              'Rejected Teltonika IMEI handshake from an unregistered or incompatible device.',
            );
            socket.end();
            return;
          }

          state.imei = parsedImei.imei;
          state.device = device;

          this.logger.log(
            `Teltonika IMEI accepted | deviceId=${device.id} | assetId=${device.assetId ?? 'UNASSIGNED'}`,
          );

          continue;
        }

        const parsedPacket = this.parser.tryReadAvlPacket(state.buffer);
        if (!parsedPacket) return;

        state.buffer = state.buffer.subarray(parsedPacket.consumedBytes);

        if (!state.device) {
          socket.write(this.parser.buildRecordAck(0));
          socket.end();
          return;
        }

        try {
          const result =
            await this.telemetryIngestionService.ingestTeltonikaCodec8Extended({
              companyId: state.device.companyId,
              deviceId: state.device.id,
              transport: TelemetryTransport.TCP,
              payload: parsedPacket.packet.toString('hex'),
              payloadEncoding: 'hex',
              metadata: {
                source: 'teltonika-tcp-server',
              },
            });

          socket.write(this.parser.buildRecordAck(result.telemetryRecordCount));

          this.logger.log(
            `Teltonika telemetry ingested | deviceId=${state.device.id} | assetId=${state.device.assetId} | records=${result.telemetryRecordCount} | readings=${result.readingCount} | status=${result.parseStatus}`,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Unknown Teltonika ingestion error';

          socket.write(this.parser.buildRecordAck(0));

          this.logger.error(
            `Failed to ingest Teltonika telemetry | deviceId=${state.device.id} | error=${message}`,
          );
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown Teltonika TCP error';

      this.logger.error(`Teltonika TCP protocol error: ${message}`);

      if (!socket.destroyed) {
        if (!state.imei) {
          socket.write(this.parser.buildImeiAck(false));
        } else {
          socket.write(this.parser.buildRecordAck(0));
        }
        socket.end();
      }
    } finally {
      state.processing = false;

      if (state.buffer.length && !socket.destroyed) {
        void this.drain(socket, state);
      }
    }
  }

  onApplicationShutdown() {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    if (!this.server) return;

    this.logger.log('Closing Teltonika TCP server...');
    this.server.close();
    this.server = null;
  }
}
