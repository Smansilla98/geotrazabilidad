import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IngestBatchRequest } from '@geo/shared';
import { AppError, Auth, DeviceAuth, parse, type Principal } from '../common/http.js';
import { env } from '../config/env.js';
import { IngestService } from './ingest.service.js';

@Controller('v1/ingest')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  /** Límites: 500 puntos y 1 MB por lote (body parser); rate limit por dispositivo. */
  @Post('batches')
  @DeviceAuth('only')
  @HttpCode(200)
  @Throttle({ default: { limit: () => env().INGEST_RATE_LIMIT_PER_MIN, ttl: 60_000 } })
  batch(@Auth() p: Principal, @Body() body: unknown) {
    if (p.kind !== 'device') throw new AppError(403, 'DEVICE_TOKEN_REQUIRED', 'Se requiere el token del dispositivo');
    if (Array.isArray((body as { points?: unknown[] })?.points) && (body as { points: unknown[] }).points.length > 500) {
      throw new AppError(413, 'BATCH_TOO_LARGE', 'Máximo 500 puntos por lote');
    }
    return this.ingest.ingest(p.deviceId, parse(IngestBatchRequest, body));
  }
}
