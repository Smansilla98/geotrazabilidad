import { Controller, Get, Param, Query } from '@nestjs/common';
import { EventsQuery, Uuid } from '@geo/shared';
import { Auth, parse, userIdOf, type Principal } from '../common/http.js';
import { EventsService } from './events.service.js';

@Controller('v1/events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  list(@Auth() p: Principal, @Query() q: unknown) {
    return this.events.list(userIdOf(p), parse(EventsQuery, q));
  }

  @Get(':id')
  get(@Auth() p: Principal, @Param('id') id: string) {
    return this.events.get(userIdOf(p), parse(Uuid, id));
  }
}
