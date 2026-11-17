import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireRole, userRateLimitKey } from '../../core/auth';
import { errorResponses, ItemIdParams } from '../../core/dto';
import { env } from '../../core/env';
import type { ItemsController } from './items.controller';
import { FeedQuery, ItemDetailDto, ItemDto, ItemListDto, MyItemsQuery } from './items.dto';

export function itemsRoutes(app: FastifyInstance, ctrl: ItemsController) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post('/items', {
    preHandler: [requireRole('DONOR')],
    config: {
      rateLimit: { max: env.ITEMS_RATE_LIMIT_MAX, timeWindow: '1 minute', keyGenerator: userRateLimitKey },
    },
    schema: {
      tags: ['Items'],
      summary: 'Publicar item com exatamente 3 fotos (DONOR) — multipart/form-data, campo `photos` ×3',
      consumes: ['multipart/form-data'],
      response: { 201: ItemDto, ...errorResponses(400, 401, 403, 413, 429) },
    },
    handler: ctrl.publish,
  });

  r.get('/items/feed', {
    preHandler: [requireRole('DONOR', 'NGO')],
    schema: {
      tags: ['Items'],
      summary: 'Feed da cidade/UF do usuário logado',
      querystring: FeedQuery,
      response: { 200: ItemListDto, ...errorResponses(400, 401, 403) },
    },
    handler: ctrl.feed,
  });

  r.get('/items/me', {
    preHandler: [requireRole('DONOR', 'NGO')],
    schema: {
      tags: ['Items'],
      summary: 'Minhas doações (DONOR) ou meus interesses (NGO)',
      querystring: MyItemsQuery,
      response: { 200: ItemListDto, ...errorResponses(400, 401, 403) },
    },
    handler: ctrl.mine,
  });

  r.get('/items/:itemId', {
    schema: {
      tags: ['Items'],
      summary: 'Detalhe do item',
      params: ItemIdParams,
      response: { 200: ItemDetailDto, ...errorResponses(400, 401, 404) },
    },
    handler: ctrl.detail,
  });
}
