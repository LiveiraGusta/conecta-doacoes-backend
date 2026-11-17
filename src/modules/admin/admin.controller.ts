import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  toAdminNgoListDto,
  toNgoStatusResultDto,
  type ListNgosQuery,
  type NgoProfileIdParams,
  type UpdateNgoStatusBody,
} from './admin.dto';
import type { AdminService } from './admin.service';

export const createAdminController = (service: AdminService) => ({
  listNgos: async (req: FastifyRequest<{ Querystring: ListNgosQuery }>, reply: FastifyReply) => {
    const result = await service.listNgos(req.query);
    return reply.status(200).send(toAdminNgoListDto(result));
  },

  updateNgoStatus: async (
    req: FastifyRequest<{ Params: NgoProfileIdParams; Body: UpdateNgoStatusBody }>,
    reply: FastifyReply,
  ) => {
    const profile = await service.updateNgoStatus(
      req.params.ngoProfileId,
      req.body.status,
      req.body.rejection_reason,
    );
    return reply.status(200).send(toNgoStatusResultDto(profile));
  },
});

export type AdminController = ReturnType<typeof createAdminController>;
