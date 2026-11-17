import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireActiveNgo, requireRole, userRateLimitKey } from '../../core/auth';
import { errorResponses, ItemIdParams } from '../../core/dto';
import { env } from '../../core/env';
import type { ChatsController } from './chats.controller';
import {
  CancelBody,
  CancelResultDto,
  ChatListDto,
  ChatListQuery,
  ChatRoomDto,
  ConfirmResultDto,
  MessageDto,
  MessagesQuery,
  SendMessageBody,
} from './chats.dto';

export function chatsRoutes(app: FastifyInstance, ctrl: ChatsController) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Participação (é o doador? é a ONG selecionada?) é checada no service.
  const parties = [requireRole('DONOR', 'NGO')];

  r.get('/chats', {
    preHandler: parties,
    schema: {
      tags: ['Chats'],
      summary: 'Listar minhas conversas',
      querystring: ChatListQuery,
      response: { 200: ChatListDto, ...errorResponses(400, 401, 403) },
    },
    handler: ctrl.list,
  });

  r.get('/chats/:itemId/messages', {
    preHandler: parties,
    schema: {
      tags: ['Chats'],
      summary: 'Histórico da sala (e polling com ?after); em tempo real, use o WebSocket /chats/ws',
      params: ItemIdParams,
      querystring: MessagesQuery,
      response: { 200: ChatRoomDto, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: ctrl.room,
  });

  r.post('/chats/:itemId/messages', {
    preHandler: parties,
    config: {
      rateLimit: { max: env.MESSAGES_RATE_LIMIT_MAX, timeWindow: '1 minute', keyGenerator: userRateLimitKey },
    },
    schema: {
      tags: ['Chats'],
      summary: 'Enviar mensagem',
      params: ItemIdParams,
      body: SendMessageBody,
      response: { 201: MessageDto, ...errorResponses(400, 401, 403, 404, 409, 429) },
    },
    handler: ctrl.send,
  });

  r.post('/items/:itemId/confirm-receipt', {
    preHandler: [requireActiveNgo],
    schema: {
      tags: ['Chats'],
      summary: 'Confirmar recebimento (EM_PROGRESSO → DOADO) — ONG selecionada e ATIVO',
      params: ItemIdParams,
      response: { 200: ConfirmResultDto, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: ctrl.confirmReceipt,
  });

  r.post('/items/:itemId/cancel', {
    preHandler: parties,
    schema: {
      tags: ['Chats'],
      summary: 'Cancelar negociação (EM_PROGRESSO → DISPONIVEL) — doador ou ONG selecionada',
      params: ItemIdParams,
      body: CancelBody,
      response: { 200: CancelResultDto, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: ctrl.cancel,
  });
}
