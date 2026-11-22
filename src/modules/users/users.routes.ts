import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { errorResponses } from '../../core/dto';
import { env } from '../../core/env';
import type { UsersController } from './users.controller';
import { PublicUserDto, UserDonationsDto, UserDonationsQuery, UserIdParams, UserProfileDto } from './users.dto';

export function usersRoutes(app: FastifyInstance, ctrl: UsersController) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/users/:userId', {
    schema: {
      tags: ['Users'],
      summary: 'Página pessoal de um doador ou ONG (logado)',
      params: UserIdParams,
      response: { 200: UserProfileDto, ...errorResponses(400, 401, 404) },
    },
    handler: ctrl.profile,
  });

  r.get('/users/:userId/donations', {
    schema: {
      tags: ['Users'],
      summary: 'Doações concluídas do doador (se ele mostrar) ou recebidas pela ONG',
      params: UserIdParams,
      querystring: UserDonationsQuery,
      response: { 200: UserDonationsDto, ...errorResponses(400, 401, 404) },
    },
    handler: ctrl.donations,
  });

  // ── Visitante (sem login) ──
  r.get('/public/users/:userId', {
    config: { public: true, rateLimit: { max: env.PUBLIC_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
    schema: {
      tags: ['Public'],
      summary: 'Página pessoal para visitante: sem nome, foto, banner, endereço nem contatos',
      security: [],
      params: UserIdParams,
      response: { 200: PublicUserDto, ...errorResponses(400, 404, 429) },
    },
    handler: ctrl.publicProfile,
  });
}
