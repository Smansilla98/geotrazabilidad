import { Inject, Injectable } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../config/env.js';
import { ENV } from '../auth/tokens.js';
import { logger } from '../logger.js';

/**
 * Envío de correo por SMTP (SMTP_URL). Sin SMTP configurado:
 * - en desarrollo/test se registra que el correo no se envió (sin el enlace: contiene un token);
 *   el contenido queda accesible en memoria para las pruebas;
 * - en producción se registra un error: la recuperación de contraseña no funciona sin SMTP.
 */
@Injectable()
export class Mailer {
  private readonly transport: Transporter | null;
  readonly outbox: Array<{ to: string; subject: string; text: string }> = [];

  constructor(@Inject(ENV) private readonly env: Env) {
    this.transport = env.SMTP_URL ? nodemailer.createTransport(env.SMTP_URL) : null;
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    if (!this.transport) {
      if (this.env.NODE_ENV !== 'production') this.outbox.push({ to, subject, text });
      const level = this.env.NODE_ENV === 'production' ? 'error' : 'warn';
      logger[level]({ subject }, 'mail.not_sent_smtp_missing');
      return;
    }
    try {
      await this.transport.sendMail({ from: this.env.MAIL_FROM, to, subject, text });
    } catch (err) {
      logger.error({ err: { message: (err as Error).message }, subject }, 'mail.send_failed');
    }
  }
}
