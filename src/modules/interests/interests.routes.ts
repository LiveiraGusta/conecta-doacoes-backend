import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireActiveNgo, requireRole } from '../../core/auth';
import { errorResponses, ItemIdParams } from '../../core/dto';
import type { InterestsController } from './interests.controller';
import { InterestDto, InterestListDto, SelectionDto, SelectNgoBody } from './interests.dto';

export function interestsRoutes(app: FastifyInstance, ctrl: InterestsController) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post('/items/:itemId/interest', {
    preHandler: [requireActiveNgo],
    schema: {
      tags: ['Interests'],
      summary: 'Demonstrar interesse (like) — NGO ATIVO, item DISPONIVEL da mesma cidade/UF',
      params: ItemIdParams,
      response: { 201: InterestDto, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: ctrl.like,
  });

  r.delete('/items/:itemId/interest', {
    preHandler: [requireRole('NGO')],
    schema: {
      tags: ['Interests'],
      summary: 'Desfazer interesse — bloqueado se a ONG já foi selecionada',
      params: ItemIdParams,
      response: { 204: z.null().describe('Interesse removido'), ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: ctrl.unlike,
  });

  r.get('/items/:itemId/interests', {
    preHandler: [requireRole('DONOR')],
    schema: {
      tags: ['Interests'],
      summary: 'Listar ONGs interessadas (DONOR dono do item)',
      params: ItemIdParams,
      response: { 200: InterestListDto, ...errorResponses(400, 401, 403, 404) },
    },
    handler: ctrl.listInterested,
  });

  r.post('/items/:itemId/select-ngo', {
    preHandler: [requireRole('DONOR')],
    schema: {
      tags: ['Interests'],
      summary: 'Escolher ONG e abrir chat (DISPONIVEL → EM_PROGRESSO)',
      params: ItemIdParams,
      body: SelectNgoBody,
      response: { 200: SelectionDto, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: ctrl.selectNgo,
  });
}
