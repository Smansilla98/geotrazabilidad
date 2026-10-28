import { Controller, Get, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AccessService } from '../access/access.service.js';
import { Auth, userIdOf, type Principal } from '../common/http.js';
import { Notifier, type GeoUpdate } from './notifier.js';

/**
 * Server-Sent Events. Autorización por mensaje: solo se reenvían avisos de dispositivos visibles
 * para el usuario (lista refrescada cada 60 s). Ante una reconexión el cliente debe volver a
 * consultar desde su último timestamp: el stream es un aviso, no la fuente de datos.
 */
@Controller('v1')
export class StreamController {
  constructor(
    private readonly notifier: Notifier,
    private readonly access: AccessService,
  ) {}

  @Get('stream')
  @SkipThrottle()
  async stream(@Auth() p: Principal, @Req() req: Request, @Res() res: Response) {
    const userId = userIdOf(p);
    let visible = new Set(await this.access.visibleDeviceIds(userId));
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    let id = 0;
    const send = (event: string, data: unknown) => res.write(`id: ${Date.now()}-${id++}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('ready', { serverTime: new Date().toISOString(), retryMs: 3000 });
    res.write('retry: 3000\n\n');

    const unsubscribe = this.notifier.subscribe((u: GeoUpdate) => {
      if (!visible.has(u.deviceId)) return;
      const { orgId: _orgId, ...safe } = u;
      send(u.type, safe);
    });
    // Comentario cada 25 s: mantiene la conexión viva a través de proxies (Railway corta conexiones inactivas).
    const keepAlive = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 25_000);
    const refresh = setInterval(async () => {
      visible = new Set(await this.access.visibleDeviceIds(userId).catch(() => [...visible]));
    }, 60_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      clearInterval(refresh);
      unsubscribe();
    });
  }
}
