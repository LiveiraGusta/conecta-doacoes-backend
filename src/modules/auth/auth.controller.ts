import type { FastifyReply, FastifyRequest } from 'fastify';
import { readMultipart } from '../../core/multipart';
import { clearSessionCookie, setSessionCookie } from '../../core/session-cookie';
import {
  RegisterNgoFields,
  toAuthResponseDto,
  toUserDto,
  type ForgotPasswordBody,
  type LoginBody,
  type RegisterDonorBody,
  type ResetPasswordBody,
} from './auth.dto';
import type { AuthService } from './auth.service';
import type { PasswordResetService } from './password-reset.service';

export const createAuthController = (
  service: AuthService,
  opts: { maxFileBytes: number; passwordReset: PasswordResetService },
) => ({
  registerDonor: async (req: FastifyRequest<{ Body: RegisterDonorBody }>, reply: FastifyReply) => {
    const result = await service.registerDonor(req.body);
    setSessionCookie(reply, result.token);
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
    setSessionCookie(reply, result.token);
    return reply.status(201).send(toAuthResponseDto(result));
  },

  login: async (req: FastifyRequest<{ Body: LoginBody }>, reply: FastifyReply) => {
    const result = await service.login(req.body.email, req.body.password);
    setSessionCookie(reply, result.token);
    return reply.status(200).send(toAuthResponseDto(result));
  },

  /** Pública e idempotente: com o cookie httpOnly, só o servidor consegue apagar a sessão do navegador. */
  logout: async (_req: FastifyRequest, reply: FastifyReply) => {
    clearSessionCookie(reply);
    return reply.status(204).send(null);
  },

  me: async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await service.me(req.user.id);
    return reply.status(200).send({ user: toUserDto(user) });
  },

  forgotPassword: async (req: FastifyRequest<{ Body: ForgotPasswordBody }>, reply: FastifyReply) => {
    await opts.passwordReset.requestReset(req.body.email);
    return reply.status(202).send();
  },

  resetPassword: async (req: FastifyRequest<{ Body: ResetPasswordBody }>, reply: FastifyReply) => {
    await opts.passwordReset.resetPassword(req.body.token, req.body.new_password);
    return reply.status(204).send(null);
  },
});

export type AuthController = ReturnType<typeof createAuthController>;
