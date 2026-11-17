import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole, userRateLimitKey } from '../../core/auth';
import { errorResponses, ItemIdParams } from '../../core/dto';
import type { ReportsController } from './reports.controller';
import {
  CreateReportBody,
  ListReportsQuery,
  ReportDetailDto,
  ReportDto,
  ReportIdParams,
  ReportListDto,
  ResolveReportBody,
} from './reports.dto';

export function reportsRoutes(app: FastifyInstance, ctrl: ReportsController) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const admin = [requireRole('ADMIN')];

  r.post('/chats/:itemId/report', {
    // Participação é checada no service, como no chat.
    preHandler: [requireRole('DONOR', 'NGO')],
    config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: userRateLimitKey } },
    schema: {
      tags: ['Reports'],
      summary: 'Denunciar a outra parte da negociação',
      params: ItemIdParams,
      body: CreateReportBody,
      response: { 201: ReportDto, ...errorResponses(400, 401, 403, 404, 409, 429) },
    },
    handler: ctrl.create,
  });

  r.get('/admin/reports', {
    preHandler: admin,
    schema: {
      tags: ['Reports'],
      summary: 'Fila de denúncias, mais antigas primeiro (ADMIN)',
      querystring: ListReportsQuery,
      response: { 200: ReportListDto, ...errorResponses(400, 401, 403) },
    },
    handler: ctrl.list,
  });

  r.get('/admin/reports/:reportId', {
    preHandler: admin,
    schema: {
      tags: ['Reports'],
      summary: 'Denúncia com a conversa completa do item (ADMIN)',
      params: ReportIdParams,
      response: { 200: ReportDetailDto, ...errorResponses(400, 401, 403, 404) },
    },
    handler: ctrl.detail,
  });

  r.patch('/admin/reports/:reportId', {
    preHandler: admin,
    schema: {
      tags: ['Reports'],
      summary: 'Resolver denúncia (ADMIN; idempotente)',
      params: ReportIdParams,
      body: ResolveReportBody,
      response: { 200: ReportDto, ...errorResponses(400, 401, 403, 404) },
    },
    handler: ctrl.resolve,
  });
}
