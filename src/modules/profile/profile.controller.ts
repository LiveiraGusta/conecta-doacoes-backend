import type { FastifyReply, FastifyRequest } from 'fastify';
import { readMultipart } from '../../core/multipart';
import { clearSessionCookie, setSessionCookie } from '../../core/session-cookie';
import { toPreferencesDto, toUserDto } from '../auth/auth.dto';
import type { ChangePasswordBody, DeleteAccountBody, UpdatePreferencesBody, UpdateProfileBody } from './profile.dto';
import type { ProfileService } from './profile.service';

export const createProfileController = (service: ProfileService, opts: { maxFileBytes: number }) => {
  /** Lê o multipart de foto de perfil/banner: 1 arquivo no campo indicado. */
  const readImage = async (req: FastifyRequest, field: 'avatar' | 'banner') => {
    const { files } = await readMultipart(req, {
      maxFiles: 1,
      maxFileBytes: opts.maxFileBytes,
      onTooManyFiles: 'INVALID_PHOTO',
      onFileTooLarge: 'PAYLOAD_TOO_LARGE',
    });
    return files.filter((f) => f.fieldname === field).map((f) => f.buffer);
  };

  return {
    update: async (req: FastifyRequest<{ Body: UpdateProfileBody }>, reply: FastifyReply) => {
      const user = await service.update(req.user, req.body);
      return reply.status(200).send({ user: toUserDto(user) });
    },

    getPreferences: async (req: FastifyRequest, reply: FastifyReply) => {
      return reply.status(200).send(toPreferencesDto(await service.getPreferences(req.user)));
    },

    updatePreferences: async (req: FastifyRequest<{ Body: UpdatePreferencesBody }>, reply: FastifyReply) => {
      return reply.status(200).send(toPreferencesDto(await service.updatePreferences(req.user, req.body)));
    },

    changePassword: async (req: FastifyRequest<{ Body: ChangePasswordBody }>, reply: FastifyReply) => {
      await service.changePassword(req.user, req.body.current_password, req.body.new_password);
      // As outras sessões caem (tokens anteriores à troca); esta recebe um cookie novo e continua logada.
      setSessionCookie(reply, await reply.jwtSign({ sub: req.user.id, role: req.user.role }));
      return reply.status(204).send();
    },

    setAvatar: async (req: FastifyRequest, reply: FastifyReply) => {
      const user = await service.setAvatar(req.user, await readImage(req, 'avatar'));
      return reply.status(200).send({ user: toUserDto(user) });
    },

    removeAvatar: async (req: FastifyRequest, reply: FastifyReply) => {
      return reply.status(200).send({ user: toUserDto(await service.removeAvatar(req.user)) });
    },

    setBanner: async (req: FastifyRequest, reply: FastifyReply) => {
      const user = await service.setBanner(req.user, await readImage(req, 'banner'));
      return reply.status(200).send({ user: toUserDto(user) });
    },

    removeBanner: async (req: FastifyRequest, reply: FastifyReply) => {
      return reply.status(200).send({ user: toUserDto(await service.removeBanner(req.user)) });
    },

    resubmitDocument: async (req: FastifyRequest, reply: FastifyReply) => {
      const { files } = await readMultipart(req, {
        maxFiles: 1,
        maxFileBytes: opts.maxFileBytes,
        onTooManyFiles: 'INVALID_DOCUMENT',
        onFileTooLarge: 'INVALID_DOCUMENT',
      });
      const documents = files.filter((f) => f.fieldname === 'document').map((f) => f.buffer);
      const user = await service.resubmitDocument(req.user, documents);
      return reply.status(200).send({ user: toUserDto(user) });
    },

    deleteAccount: async (req: FastifyRequest<{ Body: DeleteAccountBody }>, reply: FastifyReply) => {
      await service.deleteAccount(req.user, req.body.password);
      clearSessionCookie(reply);
      return reply.status(204).send();
    },
  };
};

export type ProfileController = ReturnType<typeof createProfileController>;
