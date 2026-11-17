import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { errorResponses } from '../../core/dto';
import { env } from '../../core/env';
import type { AuthController } from './auth.controller';
import { AuthResponseDto, LoginBody, MeResponseDto, RegisterDonorBody } from './auth.dto';

export function authRoutes(app: FastifyInstance, ctrl: AuthController) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Públicas, com rate limit mais rígido por IP (força bruta de senha e spam de cadastro).
  const publicAuth = { public: true, rateLimit: { max: env.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' } };

  r.post('/auth/register/donor', {
    config: publicAuth,
    schema: {
      tags: ['Auth'],
      summary: 'Cadastrar doador',
      security: [],
      body: RegisterDonorBody,
      response: { 201: AuthResponseDto, ...errorResponses(400, 409, 429) },
    },
    handler: ctrl.registerDonor,
  });

  r.post('/auth/register/ngo', {
    config: publicAuth,
    schema: {
      tags: ['Auth'],
      summary: 'Cadastrar ONG (nasce PENDENTE_APROVACAO) — multipart/form-data com o arquivo `document`',
      security: [],
      consumes: ['multipart/form-data'],
      response: { 201: AuthResponseDto, ...errorResponses(400, 409, 429) },
    },
    handler: ctrl.registerNgo,
  });

  r.post('/auth/login', {
    config: publicAuth,
    schema: {
      tags: ['Auth'],
      summary: 'Login',
      security: [],
      body: LoginBody,
      response: { 200: AuthResponseDto, ...errorResponses(400, 401, 429) },
    },
    handler: ctrl.login,
  });

  r.get('/auth/me', {
    schema: {
      tags: ['Auth'],
      summary: 'Usuário do token, lido do banco',
      response: { 200: MeResponseDto, ...errorResponses(401) },
    },
    handler: ctrl.me,
  });
}
