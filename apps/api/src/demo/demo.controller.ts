import { Body, Controller, Delete, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Uuid } from '@geo/shared';
import { AccessService } from '../access/access.service.js';
import { ENV } from '../auth/tokens.js';
import { AppError, Auth, parse, userIdOf, type Principal } from '../common/http.js';
import type { Env } from '../config/env.js';
import { DemoService } from './demo.service.js';

@Controller('v1/demo')
export class DemoController {
  constructor(
    private readonly demo: DemoService,
    private readonly access: AccessService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('load')
  async load(@Auth() p: Principal, @Body() body: unknown) {
    if (!this.env.DEMO_ENABLED) throw new AppError(404, 'NOT_FOUND', 'El modo demostración está deshabilitado');
    const uid = userIdOf(p);
    const { orgId } = parse(z.object({ orgId: Uuid.optional() }), body ?? {});
    const org = await this.access.resolveOrg(uid, orgId, ['owner', 'admin']);
    return { orgId: org, ...(await this.demo.load(org, uid)) };
  }

  @Delete()
  @HttpCode(204)
  async clear(@Auth() p: Principal, @Query() q: unknown) {
    const uid = userIdOf(p);
    const { orgId } = parse(z.object({ orgId: Uuid.optional() }), q);
    await this.demo.clear(await this.access.resolveOrg(uid, orgId, ['owner', 'admin']));
  }
}
