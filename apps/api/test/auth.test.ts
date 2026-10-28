import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, registerUser, uniqueEmail, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(async () => ctx.close());

describe('autenticación', () => {
  it('registra, inicia sesión y devuelve el perfil con organización owner', async () => {
    const u = await registerUser(ctx, 'Ana');
    const me = await ctx.http().get('/v1/me').set('Authorization', `Bearer ${u.token}`).expect(200);
    expect(me.body.memberships).toHaveLength(1);
    expect(me.body.memberships[0].role).toBe('owner');
    expect(me.body.memberships[0].retentionDays).toBe(90);
    await ctx.http().post('/v1/auth/login').send({ email: u.email.toUpperCase(), password: 'contraseña-segura-1' }).expect(200);
  });

  it('rechaza credenciales incorrectas y emails duplicados', async () => {
    const u = await registerUser(ctx);
    const bad = await ctx.http().post('/v1/auth/login').send({ email: u.email, password: 'otra-cosa-123' }).expect(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    await ctx.http().post('/v1/auth/login').send({ email: uniqueEmail(), password: 'otra-cosa-123' }).expect(401);
    const dup = await ctx.http().post('/v1/auth/register').send({ email: u.email, password: 'contraseña-segura-1', displayName: 'X' }).expect(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('valida las entradas con el contrato compartido', async () => {
    const r = await ctx.http().post('/v1/auth/register').send({ email: 'no-es-email', password: 'corta', displayName: '' }).expect(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(r.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['displayName', 'email', 'password']);
  });

  it('exige token y rechaza tokens inválidos', async () => {
    await ctx.http().get('/v1/me').expect(401);
    await ctx.http().get('/v1/me').set('Authorization', 'Bearer xxx.yyy.zzz').expect(401);
  });

  it('rota el refresh token y detecta su reuso fuera del margen', async () => {
    const u = await registerUser(ctx);
    const r1 = await ctx.http().post('/v1/auth/refresh').send({ refreshToken: u.refresh }).expect(200);
    expect(r1.body.refreshToken).not.toBe(u.refresh);
    // Reuso dentro del margen de 60 s (respuesta perdida): se permite.
    await ctx.http().post('/v1/auth/refresh').send({ refreshToken: u.refresh }).expect(200);
    // Fuera del margen: se considera robo y se revoca toda la familia.
    await ctx.db.query(`UPDATE refresh_tokens SET replaced_at = now() - interval '5 minutes' WHERE user_id = $1 AND replaced_at IS NOT NULL`, [u.userId]);
    await ctx.http().post('/v1/auth/refresh').send({ refreshToken: u.refresh }).expect(401);
    await ctx.http().post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);
  });

  it('logout revoca la sesión', async () => {
    const u = await registerUser(ctx);
    await ctx.http().post('/v1/auth/logout').send({ refreshToken: u.refresh }).expect(204);
    await ctx.http().post('/v1/auth/refresh').send({ refreshToken: u.refresh }).expect(401);
  });

  it('recupera la contraseña con un token de un solo uso', async () => {
    const u = await registerUser(ctx);
    await ctx.http().post('/v1/auth/password/forgot').send({ email: uniqueEmail() }).expect(202); // inexistente: misma respuesta
    await ctx.http().post('/v1/auth/password/forgot').send({ email: u.email }).expect(202);
    const mail = ctx.mailer.outbox.findLast((m) => m.to === u.email)!;
    const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.text)![1]!);
    await ctx.http().post('/v1/auth/password/reset').send({ token, password: 'nueva-contraseña-99' }).expect(204);
    await ctx.http().post('/v1/auth/password/reset').send({ token, password: 'otra-contraseña-99' }).expect(400);
    await ctx.http().post('/v1/auth/login').send({ email: u.email, password: 'nueva-contraseña-99' }).expect(200);
    await ctx.http().post('/v1/auth/refresh').send({ refreshToken: u.refresh }).expect(401); // sesiones previas cerradas
  });
});
