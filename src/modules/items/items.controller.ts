import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ItemIdParams } from '../../core/dto';
import { readMultipart } from '../../core/multipart';
import {
  PublishItemFields,
  toItemDetailDto,
  toItemDto,
  toPublicItemDto,
  toPublicItemListDto,
  type PublicFeedQuery,
  toItemListDto,
  type FeedQuery,
  type MyItemsQuery,
} from './items.dto';
import type { ItemsService } from './items.service';

export const createItemsController = (service: ItemsService, opts: { maxFileBytes: number }) => ({
  publish: async (req: FastifyRequest, reply: FastifyReply) => {
    const { fields, files } = await readMultipart(req, {
      maxFiles: 3,
      maxFileBytes: opts.maxFileBytes,
      onTooManyFiles: 'INVALID_PHOTO_COUNT',
      onFileTooLarge: 'PAYLOAD_TOO_LARGE',
    });
    const input = PublishItemFields.parse(fields);
    const photos = files.filter((f) => f.fieldname === 'photos').map((f) => f.buffer);
    const item = await service.publish(req.user, input, photos);
    return reply.status(201).send(toItemDto(item));
  },

  feed: async (req: FastifyRequest<{ Querystring: FeedQuery }>, reply: FastifyReply) => {
    const page = await service.feed(req.user, req.query);
    return reply.status(200).send(toItemListDto(page));
  },

  mine: async (req: FastifyRequest<{ Querystring: MyItemsQuery }>, reply: FastifyReply) => {
    const page = await service.mine(req.user, req.query);
    return reply.status(200).send(toItemListDto(page));
  },

  detail: async (req: FastifyRequest<{ Params: ItemIdParams }>, reply: FastifyReply) => {
    const item = await service.detail(req.user, req.params.itemId);
    return reply.status(200).send(toItemDetailDto(item));
  },

  publicFeed: async (req: FastifyRequest<{ Querystring: PublicFeedQuery }>, reply: FastifyReply) => {
    return reply.status(200).send(toPublicItemListDto(await service.publicFeed(req.query)));
  },

  publicDetail: async (req: FastifyRequest<{ Params: ItemIdParams }>, reply: FastifyReply) => {
    return reply.status(200).send(toPublicItemDto(await service.publicDetail(req.params.itemId)));
  },
});

export type ItemsController = ReturnType<typeof createItemsController>;
