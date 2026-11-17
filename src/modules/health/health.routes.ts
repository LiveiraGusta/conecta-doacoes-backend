import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { HealthController } from './health.controller';
import { HealthDto, ReadinessDto } from './health.dto';

/** Fora de /api/v1, sem token e sem rate limit: quem consome é a plataforma de deploy. */
export function healthRoutes(app: FastifyInstance, ctrl: HealthController) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const config = { public: true, rateLimit: false } as const;

  r.get('/health', {
    config,
    schema: { tags: ['Health'], summary: 'Liveness — o processo está vivo', security: [], response: { 200: HealthDto } },
    handler: ctrl.live,
  });

  r.get('/health/ready', {
    config,
    schema: {
      tags: ['Health'],
      summary: 'Readiness — banco respondendo em até 2 s',
      security: [],
      response: { 200: ReadinessDto, 503: ReadinessDto },
    },
    handler: ctrl.ready,
  });
}
