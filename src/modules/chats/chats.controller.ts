import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ItemIdParams } from '../../core/dto';
import {
  toCancelResultDto,
  toChatListDto,
  toChatRoomDto,
  toConfirmResultDto,
  toMessageDto,
  type CancelBody,
  type ChatListQuery,
  type MessagesQuery,
  type SendMessageBody,
} from './chats.dto';
import type { ChatsService } from './chats.service';

export const createChatsController = (service: ChatsService) => ({
  list: async (req: FastifyRequest<{ Querystring: ChatListQuery }>, reply: FastifyReply) => {
    const page = await service.list(req.user, req.query);
    return reply.status(200).send(toChatListDto(page));
  },

  room: async (req: FastifyRequest<{ Params: ItemIdParams; Querystring: MessagesQuery }>, reply: FastifyReply) => {
    const after = req.query.after ? new Date(req.query.after) : undefined;
    const room = await service.room(req.user, req.params.itemId, after);
    return reply.status(200).send(toChatRoomDto(room));
  },

  send: async (req: FastifyRequest<{ Params: ItemIdParams; Body: SendMessageBody }>, reply: FastifyReply) => {
    const message = await service.send(req.user, req.params.itemId, req.body.message);
    return reply.status(201).send(toMessageDto(message));
  },

  confirmReceipt: async (req: FastifyRequest<{ Params: ItemIdParams }>, reply: FastifyReply) => {
    const item = await service.confirmReceipt(req.user, req.params.itemId);
    return reply.status(200).send(toConfirmResultDto(item));
  },

  cancel: async (req: FastifyRequest<{ Params: ItemIdParams; Body: CancelBody }>, reply: FastifyReply) => {
    const result = await service.cancel(req.user, req.params.itemId, req.body?.reason);
    return reply.status(200).send(toCancelResultDto(result));
  },
});

export type ChatsController = ReturnType<typeof createChatsController>;
