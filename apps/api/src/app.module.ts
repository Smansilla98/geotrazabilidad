import 'reflect-metadata';
import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AccessService } from './access/access.service.js';
import { AuditService } from './audit/audit.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard, PrincipalThrottlerGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { ENV } from './auth/tokens.js';
import { ErrorFilter } from './common/http.js';
import type { Env } from './config/env.js';
import { Db } from './db/db.js';
import { DemoController } from './demo/demo.controller.js';
import { DemoService } from './demo/demo.service.js';
import { DevicesController } from './devices/devices.controller.js';
import { DevicesService } from './devices/devices.service.js';
import { EventsController } from './events/events.controller.js';
import { EventsService } from './events/events.service.js';
import { ExportsController } from './exports/exports.controller.js';
import { GeofencesController } from './geofences/geofences.controller.js';
import { HealthController } from './health/health.controller.js';
import { IngestController } from './ingest/ingest.controller.js';
import { IngestService } from './ingest/ingest.service.js';
import { Mailer } from './mail/mailer.js';
import { DocsController } from './openapi/openapi.js';
import { OrgsController } from './orgs/orgs.controller.js';
import { Processor } from './processing/processor.js';
import { RetentionService } from './retention/retention.service.js';
import { RoutingService } from './routing/routing.js';
import { StatsController } from './stats/stats.controller.js';
import { Notifier } from './stream/notifier.js';
import { StreamController } from './stream/stream.controller.js';
import { TracksController } from './tracks/tracks.controller.js';
import { TracksService } from './tracks/tracks.service.js';
import { TripsController } from './trips/trips.controller.js';

/**
 * Un único módulo Nest con los dominios separados por carpeta. Para el MVP evita la ceremonia de
 * módulos anidados sin perder separación; cada carpeta puede extraerse a su módulo si crece.
 */
@Module({})
export class AppModule {
  static register(env: Env, db: Db): DynamicModule {
    return {
      module: AppModule,
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: env.RATE_LIMIT_PER_MIN }])],
      controllers: [
        HealthController,
        DocsController,
        AuthController,
        OrgsController,
        DevicesController,
        IngestController,
        TracksController,
        EventsController,
        GeofencesController,
        TripsController,
        StatsController,
        ExportsController,
        StreamController,
        DemoController,
      ],
      providers: [
        { provide: ENV, useValue: env },
        { provide: Db, useValue: db },
        { provide: APP_FILTER, useClass: ErrorFilter },
        // Orden: primero autenticación (define el principal), después rate limit por principal.
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PrincipalThrottlerGuard },
        AccessService,
        AuditService,
        AuthService,
        Mailer,
        DevicesService,
        IngestService,
        Notifier,
        Processor,
        RetentionService,
        TracksService,
        EventsService,
        RoutingService,
        DemoService,
      ],
    };
  }
}
