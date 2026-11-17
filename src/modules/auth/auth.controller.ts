import type { FastifyReply, FastifyRequest } from 'fastify';
import { readMultipart } from '../../core/multipart';
import { RegisterNgoFields, toAuthResponseDto, toUserDto, type LoginBody, type RegisterDonorBody } from './auth.dto';
import type { AuthService } from './auth.service';

export const createAuthController = (service: AuthService, opts: { maxFileBytes: number }) => ({
  registerDonor: async (req: FastifyRequest<{ Body: RegisterDonorBody }>, reply: FastifyReply) => {
    const result = await service.registerDonor(req.body);
    return reply.status(201).send(toAuthResponseDto(result));
  },

  registerNgo: async (req: FastifyRequest, reply: FastifyReply) => {
    const { fields, files } = await readMultipart(req, {
      maxFiles: 1,
      maxFileBytes: opts.maxFileBytes,
      onTooManyFiles: 'INVALID_DOCUMENT',
      onFileTooLarge: 'INVALID_DOCUMENT',
    });
    const input = RegisterNgoFields.parse(fields);
    const documents = files.filter((f) => f.fieldname === 'document').map((f) => f.buffer);
    const result = await service.registerNgo(input, documents);
    return reply.status(201).send(toAuthResponseDto(result));
  },

  login: async (req: FastifyRequest<{ Body: LoginBody }>, reply: FastifyReply) => {
    const result = await service.login(req.body.email, req.body.password);
    return reply.status(200).send(toAuthResponseDto(result));
  },

  me: async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await service.me(req.user.id);
    return reply.status(200).send({ user: toUserDto(user) });
  },
});

export type AuthController = ReturnType<typeof createAuthController>;
