import { pino } from 'pino';

/**
 * Logs estructurados en JSON (stdout → Railway). Se redactan credenciales y coordenadas:
 * los logs generales nunca deben contener contraseñas, tokens ni posiciones completas.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: process.env.SERVICE_NAME ?? 'geo-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.token',
      '*.refreshToken',
      '*.accessToken',
      '*.lat',
      '*.lon',
      '*.latitude',
      '*.longitude',
    ],
    censor: '[redactado]',
  },
});
