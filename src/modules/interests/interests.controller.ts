import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ItemIdParams } from '../../core/dto';
import { toInterestDto, toInterestListDto, toSelectionDto, type SelectNgoBody } from './interests.dto';
import type { InterestsService } from './interests.service';

export const createInterestsController = (service: InterestsService) => ({
  like: async (req: FastifyRequest<{ Params: ItemIdParams }>, reply: FastifyReply) => {
    const interest = await service.like(req.user, req.params.itemId);
    return reply.status(201).send(toInterestDto(interest));
  },

  unlike: async (req: FastifyRequest<{ Params: ItemIdParams }>, reply: FastifyReply) => {
    await service.unlike(req.user, req.params.itemId);
    return reply.status(204).send();
  },

  listInterested: async (req: FastifyRequest<{ Params: ItemIdParams }>, reply: FastifyReply) => {
    const rows = await service.listInterested(req.user, req.params.itemId);
    return reply.status(200).send(toInterestListDto(req.params.itemId, rows));
  },

  selectNgo: async (req: FastifyRequest<{ Params: ItemIdParams; Body: SelectNgoBody }>, reply: FastifyReply) => {
    const item = await service.selectNgo(req.user.id, req.params.itemId, req.body.ngo_id);
    return reply.status(200).send(toSelectionDto(item));
  },
});

export type InterestsController = ReturnType<typeof createInterestsController>;
