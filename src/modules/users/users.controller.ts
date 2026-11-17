import type { FastifyReply, FastifyRequest } from 'fastify';
import { toPublicUserDto, toUserDonationsDto, toUserProfileDto, type UserDonationsQuery, type UserIdParams } from './users.dto';
import type { UsersService } from './users.service';

export const createUsersController = (service: UsersService) => ({
  profile: async (req: FastifyRequest<{ Params: UserIdParams }>, reply: FastifyReply) => {
    return reply.status(200).send(toUserProfileDto(await service.profile(req.user, req.params.userId)));
  },

  donations: async (req: FastifyRequest<{ Params: UserIdParams; Querystring: UserDonationsQuery }>, reply: FastifyReply) => {
    const page = await service.donations(req.user, req.params.userId, req.query);
    return reply.status(200).send(toUserDonationsDto(page));
  },

  publicProfile: async (req: FastifyRequest<{ Params: UserIdParams }>, reply: FastifyReply) => {
    return reply.status(200).send(toPublicUserDto(await service.publicProfile(req.params.userId)));
  },
});

export type UsersController = ReturnType<typeof createUsersController>;
