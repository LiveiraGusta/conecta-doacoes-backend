import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole, userRateLimitKey } from '../../core/auth';
import { errorResponses } from '../../core/dto';
import { MeResponseDto, PreferencesDto } from '../auth/auth.dto';
import type { ProfileController } from './profile.controller';
import { ChangePasswordBody, DeleteAccountBody, UpdatePreferencesBody, UpdateProfileBody } from './profile.dto';

const NoContent = z.null().describe('Sem conteúdo');

export function profileRoutes(app: FastifyInstance, ctrl: ProfileController) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.patch('/profile', {
    preHandler: [requireRole('DONOR', 'NGO')],
    schema: {
      tags: ['Profile'],
      summary: 'Editar nome, cidade/UF e descrição; ONG: site, contato, categorias aceitas e endereço',
      body: UpdateProfileBody,
      response: { 200: MeResponseDto, ...errorResponses(400, 401, 403) },
    },
    handler: ctrl.update,
  });

  r.get('/profile/preferences', {
    schema: {
      tags: ['Profile'],
      summary: 'Preferências de tema e privacidade (padrões se nunca alteradas)',
      response: { 200: PreferencesDto, ...errorResponses(401) },
    },
    handler: ctrl.getPreferences,
  });

  r.patch('/profile/preferences', {
    schema: {
      tags: ['Profile'],
      summary: 'Alterar cor do tema, modo claro/escuro e (doador) mostrar doações',
      body: UpdatePreferencesBody,
      response: { 200: PreferencesDto, ...errorResponses(400, 401, 403) },
    },
    handler: ctrl.updatePreferences,
  });

  r.patch('/profile/password', {
    // Força bruta da senha atual: 5 tentativas por minuto, por usuário.
    config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: userRateLimitKey } },
    schema: {
      tags: ['Profile'],
      summary: 'Trocar senha (invalida tokens anteriores)',
      body: ChangePasswordBody,
      response: { 204: NoContent, ...errorResponses(400, 401, 429) },
    },
    handler: ctrl.changePassword,
  });

  r.put('/profile/ngo-document', {
    preHandler: [requireRole('NGO')],
    schema: {
      tags: ['Profile'],
      summary: 'Reenviar documento da ONG (volta para PENDENTE_APROVACAO) — multipart, campo `document`',
      consumes: ['multipart/form-data'],
      response: { 200: MeResponseDto, ...errorResponses(400, 401, 403, 409) },
    },
    handler: ctrl.resubmitDocument,
  });

  r.delete('/profile', {
    preHandler: [requireRole('DONOR', 'NGO')],
    schema: {
      tags: ['Profile'],
      summary: 'Excluir a conta (anonimização)',
      body: DeleteAccountBody,
      response: { 204: NoContent, ...errorResponses(400, 401, 403, 409) },
    },
    handler: ctrl.deleteAccount,
  });
}
