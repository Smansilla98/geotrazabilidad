import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ForgotPasswordRequest, LoginRequest, RefreshRequest, RegisterRequest, ResetPasswordRequest } from '@geo/shared';
import { Auth, clientMeta, parse, Public, userIdOf, type Principal } from '../common/http.js';
import { env } from '../config/env.js';
import { AuthService } from './auth.service.js';

const authLimit = () => ({ default: { limit: () => env().AUTH_RATE_LIMIT_PER_MIN, ttl: 60_000 } });

@Controller('v1')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle(authLimit())
  @Post('auth/register')
  register(@Body() body: unknown, @Req() req: Request) {
    const b = parse(RegisterRequest, body);
    return this.auth.register(b.email.toLowerCase(), b.password, b.displayName, clientMeta(req));
  }

  @Public()
  @Throttle(authLimit())
  @HttpCode(200)
  @Post('auth/login')
  login(@Body() body: unknown, @Req() req: Request) {
    const b = parse(LoginRequest, body);
    return this.auth.login(b.email.toLowerCase(), b.password, clientMeta(req));
  }

  @Public()
  @Throttle(authLimit())
  @HttpCode(200)
  @Post('auth/refresh')
  refresh(@Body() body: unknown) {
    return this.auth.refreshUser(parse(RefreshRequest, body).refreshToken);
  }

  @Public()
  @HttpCode(204)
  @Post('auth/logout')
  async logout(@Body() body: unknown) {
    await this.auth.logout(parse(RefreshRequest, body).refreshToken);
  }

  @Public()
  @Throttle(authLimit())
  @HttpCode(202)
  @Post('auth/password/forgot')
  async forgot(@Body() body: unknown) {
    await this.auth.forgotPassword(parse(ForgotPasswordRequest, body).email.toLowerCase());
    return { status: 'accepted' };
  }

  @Public()
  @Throttle(authLimit())
  @HttpCode(204)
  @Post('auth/password/reset')
  async reset(@Body() body: unknown) {
    const b = parse(ResetPasswordRequest, body);
    await this.auth.resetPassword(b.token, b.password);
  }

  @Get('me')
  me(@Auth() p: Principal) {
    return this.auth.me(userIdOf(p));
  }
}
