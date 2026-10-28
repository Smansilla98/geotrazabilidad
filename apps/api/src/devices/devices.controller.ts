import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ConsentRequest, DeviceRefreshRequest, HeartbeatRequest, RegisterDeviceRequest, UpdateDeviceRequest, Uuid } from '@geo/shared';
import { AppError, Auth, clientMeta, DeviceAuth, parse, Public, userIdOf, type Principal } from '../common/http.js';
import { env } from '../config/env.js';
import { DevicesService } from './devices.service.js';

@Controller('v1/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post()
  register(@Auth() p: Principal, @Body() body: unknown, @Req() req: Request) {
    return this.devices.register(userIdOf(p), parse(RegisterDeviceRequest, body), clientMeta(req));
  }

  @Public()
  @Throttle({ default: { limit: () => env().AUTH_RATE_LIMIT_PER_MIN, ttl: 60_000 } })
  @HttpCode(200)
  @Post('token/refresh')
  refresh(@Body() body: unknown) {
    const b = parse(DeviceRefreshRequest, body);
    return this.devices.refreshDeviceToken(b.deviceId, b.refreshToken);
  }

  @Get()
  list(@Auth() p: Principal) {
    return this.devices.list(userIdOf(p));
  }

  @Get(':id')
  @DeviceAuth('also')
  get(@Auth() p: Principal, @Param('id') id: string) {
    parse(Uuid, id);
    if (p.kind === 'device') {
      if (p.deviceId !== id) throw new AppError(404, 'NOT_FOUND', 'Dispositivo no encontrado');
      return this.devices.get(p.userId, id);
    }
    return this.devices.get(p.userId, id);
  }

  @Patch(':id')
  rename(@Auth() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.devices.rename(userIdOf(p), parse(Uuid, id), parse(UpdateDeviceRequest, body).name);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@Auth() p: Principal, @Param('id') id: string, @Req() req: Request) {
    return this.devices.revoke(userIdOf(p), parse(Uuid, id), clientMeta(req));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Auth() p: Principal, @Param('id') id: string, @Req() req: Request) {
    await this.devices.remove(userIdOf(p), parse(Uuid, id), clientMeta(req));
  }

  @Post(':id/consent')
  @HttpCode(200)
  consent(@Auth() p: Principal, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const b = parse(ConsentRequest, body);
    return this.devices.setConsent(userIdOf(p), parse(Uuid, id), b.consentVersion, b.shareWithOrg, clientMeta(req));
  }

  @Delete(':id/consent')
  @HttpCode(204)
  async revokeConsent(@Auth() p: Principal, @Param('id') id: string, @Req() req: Request) {
    await this.devices.revokeConsent(userIdOf(p), parse(Uuid, id), clientMeta(req));
  }

  @Get(':id/config')
  @DeviceAuth('only')
  config(@Auth() p: Principal, @Param('id') id: string) {
    if (p.kind !== 'device' || p.deviceId !== id) throw new AppError(404, 'NOT_FOUND', 'Dispositivo no encontrado');
    return this.devices.trackingConfig(id);
  }

  @Post(':id/heartbeat')
  @DeviceAuth('only')
  @HttpCode(200)
  heartbeat(@Auth() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    if (p.kind !== 'device' || p.deviceId !== id) throw new AppError(404, 'NOT_FOUND', 'Dispositivo no encontrado');
    return this.devices.heartbeat(id, parse(HeartbeatRequest, body));
  }
}
