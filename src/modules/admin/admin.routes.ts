import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole } from '../../core/auth';
import { errorResponses } from '../../core/dto';
import type { AdminController } from './admin.controller';
import { AdminNgoListDto, ListNgosQuery, NgoProfileIdParams, NgoStatusResultDto, UpdateNgoStatusBody } from './admin.dto';

export function adminRoutes(app: FastifyInstance, ctrl: AdminController) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const preHandler = [requireRole('ADMIN')];

  r.get('/admin/ngos', {
    preHandler,
    schema: {
      tags: ['Admin'],
      summary: 'Listar ONGs para moderação (ADMIN)',
      querystring: ListNgosQuery,
      response: { 200: AdminNgoListDto, ...errorResponses(400, 401, 403) },
    },
    handler: ctrl.listNgos,
  });

  r.patch('/admin/ngos/:ngoProfileId/status', {
    preHandler,
    schema: {
      tags: ['Admin'],
      summary: 'Aprovar ou rejeitar ONG (ADMIN)',
      params: NgoProfileIdParams,
      body: UpdateNgoStatusBody,
      response: { 200: NgoStatusResultDto, ...errorResponses(400, 401, 403, 404) },
    },
    handler: ctrl.updateNgoStatus,
  });
}
