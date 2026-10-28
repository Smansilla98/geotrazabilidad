import {
  ArgumentsHost,
  Catch,
  createParamDecorator,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  SetMetadata,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { z, ZodType } from 'zod';
import { logger } from '../logger.js';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Recurso') => new AppError(404, 'NOT_FOUND', `${what} no encontrado`);
export const forbidden = (msg = 'No tenés permiso para esta operación') => new AppError(403, 'FORBIDDEN', msg);

/** Valida con un esquema compartido; 400 con detalle por campo. */
export function parse<S extends ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Datos inválidos',
      r.error.issues.slice(0, 50).map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    let status = 500;
    let body: { error: { code: string; message: string; details?: unknown } };
    if (exception instanceof AppError) {
      status = exception.status;
      body = { error: { code: exception.code, message: exception.message, details: exception.details } };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      const code = status === 429 ? 'RATE_LIMITED' : status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR';
      body = { error: { code, message: typeof r === 'string' ? r : ((r as { message?: string }).message ?? exception.message) } };
    } else if ((exception as { type?: string })?.type === 'entity.too.large') {
      status = 413;
      body = { error: { code: 'PAYLOAD_TOO_LARGE', message: 'El cuerpo supera el límite permitido' } };
    } else if ((exception as { type?: string })?.type === 'entity.parse.failed') {
      status = 400;
      body = { error: { code: 'INVALID_JSON', message: 'JSON inválido' } };
    } else {
      body = { error: { code: 'INTERNAL_ERROR', message: 'Error interno' } };
    }
    if (status >= 500) {
      logger.error({ err: { message: (exception as Error)?.message, stack: (exception as Error)?.stack }, method: req.method, path: req.path }, 'api.error');
    }
    if (!res.headersSent) res.status(status).json(body);
  }
}

// ── Autenticación: metadatos y principal ──
export type Principal =
  | { kind: 'user'; userId: string }
  | { kind: 'device'; deviceId: string; userId: string };

export const IS_PUBLIC = 'geo:public';
export const DEVICE_ALLOWED = 'geo:device';
/** Endpoint sin autenticación. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Endpoint que acepta el token de dispositivo (además o en lugar del de usuario). */
export const DeviceAuth = (mode: 'only' | 'also' = 'only') => SetMetadata(DEVICE_ALLOWED, mode);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  return (ctx.switchToHttp().getRequest() as Request & { principal: Principal }).principal;
});

export function userIdOf(p: Principal): string {
  if (p.kind !== 'user') throw forbidden('Este endpoint requiere un usuario');
  return p.userId;
}

export function clientMeta(req: Request) {
  return { ip: req.ip ?? null, userAgent: (req.headers['user-agent'] ?? '').slice(0, 300) || null };
}
