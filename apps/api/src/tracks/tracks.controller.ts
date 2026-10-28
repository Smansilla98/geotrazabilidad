import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { IsoDateTime, TrackQuery, Uuid } from '@geo/shared';
import { Auth, clientMeta, parse, userIdOf, type Principal } from '../common/http.js';
import { TracksService } from './tracks.service.js';

const SessionsQuery = z.object({ from: IsoDateTime.optional(), to: IsoDateTime.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });
const PointsQuery = z.object({ from: IsoDateTime, to: IsoDateTime, limit: z.coerce.number().int().min(1).max(5000).default(1000), cursor: z.string().max(200).optional() });

@Controller('v1/devices/:id')
export class TracksController {
  constructor(private readonly tracks: TracksService) {}

  @Get('sessions')
  sessions(@Auth() p: Principal, @Param('id') id: string, @Query() q: unknown) {
    return this.tracks.sessions(userIdOf(p), parse(Uuid, id), parse(SessionsQuery, q));
  }

  @Get('points')
  points(@Auth() p: Principal, @Param('id') id: string, @Query() q: unknown) {
    return this.tracks.points(userIdOf(p), parse(Uuid, id), parse(PointsQuery, q));
  }

  @Get('track')
  track(@Auth() p: Principal, @Param('id') id: string, @Query() q: unknown, @Req() req: Request) {
    return this.tracks.track(userIdOf(p), parse(Uuid, id), parse(TrackQuery, q), clientMeta(req));
  }
}
