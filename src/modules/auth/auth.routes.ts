import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../../core/dto';
import { env } from '../../core/env';
import type { AuthController } from './auth.controller';
import {
  AuthResponseDto,
  ForgotPasswordBody,
  LoginBody,
  MeResponseDto,
  RegisterDonorBody,
  ResetPasswordBody,
} from './auth.dto';

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

  r.post('/auth/logout', {
    config: publicAuth,
    schema: {
      tags: ['Auth'],
      summary: 'Sair: apaga o cookie de sessão (204 mesmo sem sessão)',
      security: [],
      response: { 204: z.null().describe('Sessão encerrada'), ...errorResponses(403, 429) },
    },
    handler: ctrl.logout,
  });

  r.post('/auth/password/forgot', {
    config: publicAuth,
    schema: {
      tags: ['Auth'],
      summary: 'Pedir link de redefinição de senha (sempre 202: não revela se o e-mail existe)',
      security: [],
      body: ForgotPasswordBody,
      response: { 202: z.void().describe('Pedido recebido, sem corpo'), ...errorResponses(400, 429) },
    },
    handler: ctrl.forgotPassword,
  });

  r.post('/auth/password/reset', {
    config: publicAuth,
    schema: {
      tags: ['Auth'],
      summary: 'Definir nova senha com o token do e-mail (encerra as sessões abertas)',
      security: [],
      body: ResetPasswordBody,
      response: { 204: z.null().describe('Senha redefinida'), ...errorResponses(400, 429) },
    },
    handler: ctrl.resetPassword,
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
