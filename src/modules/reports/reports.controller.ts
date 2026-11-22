import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ItemIdParams } from '../../core/dto';
import {
  toModerationResultDto,
  toReportDetailDto,
  toReportDto,
  toReportListDto,
  type CreateItemReportBody,
  type CreateReportBody,
  type ListReportsQuery,
  type RemoveItemBody,
  type ReportIdParams,
} from './reports.dto';
import type { ReportsService } from './reports.service';

export const createReportsController = (service: ReportsService) => ({
  create: async (req: FastifyRequest<{ Params: ItemIdParams; Body: CreateReportBody }>, reply: FastifyReply) => {
    const report = await service.create(req.user, req.params.itemId, req.body.reason);
    return reply.status(201).send(toReportDto(report));
  },

  createForItem: async (
    req: FastifyRequest<{ Params: ItemIdParams; Body: CreateItemReportBody }>,
    reply: FastifyReply,
  ) => {
    const report = await service.createForItem(req.user, req.params.itemId, req.body);
    return reply.status(201).send(toReportDto(report));
  },

  list: async (req: FastifyRequest<{ Querystring: ListReportsQuery }>, reply: FastifyReply) => {
    return reply.status(200).send(toReportListDto(await service.list(req.query)));
  },

  detail: async (req: FastifyRequest<{ Params: ReportIdParams }>, reply: FastifyReply) => {
    return reply.status(200).send(toReportDetailDto(await service.detail(req.params.reportId)));
  },

  resolve: async (req: FastifyRequest<{ Params: ReportIdParams }>, reply: FastifyReply) => {
    return reply.status(200).send(toReportDto(await service.resolve(req.user, req.params.reportId)));
  },

  removeItem: async (req: FastifyRequest<{ Params: ItemIdParams; Body: RemoveItemBody }>, reply: FastifyReply) => {
    const result = await service.removeItem(req.user, req.params.itemId, req.body.reason);
    return reply.status(200).send(toModerationResultDto(result));
  },

  restoreItem: async (req: FastifyRequest<{ Params: ItemIdParams }>, reply: FastifyReply) => {
    return reply.status(200).send(toModerationResultDto(await service.restoreItem(req.user, req.params.itemId)));
  },
});

export type ReportsController = ReturnType<typeof createReportsController>;
