import { z } from 'zod';
import { isoDate, optionalText, PaginationQuery, text, toIso } from '../../core/dto';
import type {
  ChatMessage,
  Item,
  ItemEvent,
  ItemReportRow,
  Page,
  Report,
  ReportParty,
  ReportSummary,
  Role,
} from '../../types';
import { ModerationStatus } from '../items/items.dto';

// ── Entrada ──
export const CreateReportBody = z.object({ reason: text(10, 1000) });
export type CreateReportBody = z.infer<typeof CreateReportBody>;

export const ReportCategory = z.enum(['NUDEZ', 'ODIO', 'VIOLENCIA', 'GOLPE', 'PROIBIDO', 'SPAM', 'OUTRO']);

/** Denúncia de anúncio: categoria obrigatória; o texto só é obrigatório em OUTRO. */
export const CreateItemReportBody = z
  .object({ category: ReportCategory, reason: optionalText(1000) })
  .superRefine((v, ctx) => {
    if (v.category === 'OUTRO' && (v.reason?.length ?? 0) < 10) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Descreva o problema (mínimo de 10 caracteres)' });
    }
  });
export type CreateItemReportBody = z.infer<typeof CreateItemReportBody>;

const ReportStatus = z.enum(['ABERTA', 'RESOLVIDA']);
const ReportKind = z.enum(['CHAT', 'ITEM']);
const ReportResolution = z.enum(['ITEM_REMOVIDO', 'IMPROCEDENTE']);

export const ListReportsQuery = PaginationQuery.extend({
  status: ReportStatus.default('ABERTA'),
  kind: ReportKind.optional(),
});
export type ListReportsQuery = z.infer<typeof ListReportsQuery>;

export const ReportIdParams = z.object({ reportId: z.uuid() });
export type ReportIdParams = z.infer<typeof ReportIdParams>;

export const ResolveReportBody = z.object({ status: z.literal('RESOLVIDA') });
export type ResolveReportBody = z.infer<typeof ResolveReportBody>;

export const RemoveItemBody = z.object({ reason: text(10, 500) });
export type RemoveItemBody = z.infer<typeof RemoveItemBody>;

// ── Saída ──
const PartyRole = z.enum(['DONOR', 'NGO']);
const ItemStatus = z.enum(['DISPONIVEL', 'EM_PROGRESSO', 'DOADO']);
const Party = z.object({ id: z.uuid(), name: z.string(), role: PartyRole });

/** Campos comuns aos dois tipos de denúncia. */
const reportFields = {
  kind: ReportKind,
  category: ReportCategory.nullable(),
  reason: z.string().nullable(),
  status: ReportStatus,
  resolution: ReportResolution.nullable(),
  created_at: isoDate(),
};

export const ReportDto = z
  .object({
    id: z.uuid(),
    item_id: z.uuid(),
    reporter_id: z.uuid(),
    reported_id: z.uuid(),
    ...reportFields,
  })
  .describe('Report');
export type ReportDto = z.infer<typeof ReportDto>;

export const ReportSummaryDto = z
  .object({
    id: z.uuid(),
    ...reportFields,
    item: z.object({ id: z.uuid(), title: z.string(), status: ItemStatus, moderation_status: ModerationStatus }),
    reporter: Party,
    reported: Party,
  })
  .describe('ReportSummary');

export const ReportListDto = z.object({ total: z.number().int().min(0), data: z.array(ReportSummaryDto) });
export type ReportListDto = z.infer<typeof ReportListDto>;

export const ReportDetailDto = z
  .object({
    report: z.object({ id: z.uuid(), ...reportFields }),
    item: z.object({
      id: z.uuid(),
      title: z.string(),
      description: z.string().nullable(),
      status: ItemStatus,
      donor_id: z.uuid(),
      selected_ngo_id: z.uuid().nullable(),
      photos: z.array(z.string()),
      moderation_status: ModerationStatus,
      moderation_reason: z.string().nullable(),
    }),
    reporter: Party.extend({ email: z.string() }),
    reported: Party.extend({ email: z.string(), ngo_profile_id: z.uuid().nullable() }),
    /** Todas as denúncias de anúncio deste item (abertas e resolvidas), mais antigas primeiro. */
    item_reports: z.array(
      z.object({
        id: z.uuid(),
        category: ReportCategory,
        reason: z.string().nullable(),
        status: ReportStatus,
        created_at: isoDate(),
        reporter: Party,
      }),
    ),
    events: z.array(
      z.object({
        from_status: z.string().nullable(),
        to_status: z.string(),
        actor_id: z.uuid().nullable(),
        reason: z.string().nullable(),
        created_at: isoDate(),
      }),
    ),
    /** Conversa completa do item. Vazia nas denúncias de anúncio (a conversa é privada e não é o objeto). */
    messages: z.array(
      z.object({
        id: z.uuid(),
        item_id: z.uuid(),
        sender_id: z.uuid(),
        receiver_id: z.uuid(),
        message: z.string(),
        created_at: isoDate(),
      }),
    ),
  })
  .describe('ReportDetail');
export type ReportDetailDto = z.infer<typeof ReportDetailDto>;

export const ModerationResultDto = z
  .object({
    item_id: z.uuid(),
    status: ItemStatus,
    moderation_status: ModerationStatus,
    moderation_reason: z.string().nullable(),
    /** A remoção desfez uma negociação em andamento. */
    cancelled_negotiation: z.boolean(),
    /** Denúncias de anúncio abertas que esta ação resolveu. */
    resolved_reports: z.number().int().min(0),
  })
  .describe('ModerationResult');
export type ModerationResultDto = z.infer<typeof ModerationResultDto>;

// ── Mapeamento ──
const party = (role: Role) => role as z.infer<typeof PartyRole>;

const toReportFields = (r: Pick<Report, 'kind' | 'category' | 'reason' | 'status' | 'resolution' | 'created_at'>) => ({
  kind: r.kind,
  category: r.category,
  reason: r.reason,
  status: r.status,
  resolution: r.resolution,
  created_at: toIso(r.created_at),
});

export const toReportDto = (r: Report): ReportDto => ({
  id: r.id,
  item_id: r.item_id,
  reporter_id: r.reporter_id,
  reported_id: r.reported_id,
  ...toReportFields(r),
});

export const toReportListDto = (page: Page<ReportSummary>): ReportListDto => ({
  total: page.total,
  data: page.rows.map((r) => ({
    id: r.id,
    ...toReportFields(r),
    item: { id: r.item_id, title: r.item_title, status: r.item_status, moderation_status: r.item_moderation_status },
    reporter: { id: r.reporter_id, name: r.reporter_name, role: party(r.reporter_role) },
    reported: { id: r.reported_id, name: r.reported_name, role: party(r.reported_role) },
  })),
});

const toPartyDto = (p: ReportParty) => ({ id: p.id, name: p.name, role: party(p.role), email: p.email });

export const toReportDetailDto = (d: {
  report: Report;
  item: Item & { photos: string[] };
  reporter: ReportParty;
  reported: ReportParty;
  itemReports: ItemReportRow[];
  events: ItemEvent[];
  messages: ChatMessage[];
}): ReportDetailDto => ({
  report: { id: d.report.id, ...toReportFields(d.report) },
  item: {
    id: d.item.id,
    title: d.item.title,
    description: d.item.description,
    status: d.item.status,
    donor_id: d.item.donor_id,
    selected_ngo_id: d.item.selected_ngo_id,
    photos: d.item.photos,
    moderation_status: d.item.moderation_status,
    moderation_reason: d.item.moderation_reason,
  },
  reporter: toPartyDto(d.reporter),
  reported: { ...toPartyDto(d.reported), ngo_profile_id: d.reported.ngo_profile_id },
  item_reports: d.itemReports.map((r) => ({
    id: r.id,
    category: r.category,
    reason: r.reason,
    status: r.status,
    created_at: toIso(r.created_at),
    reporter: { id: r.reporter_id, name: r.reporter_name, role: party(r.reporter_role) },
  })),
  events: d.events.map((e) => ({
    from_status: e.from_status,
    to_status: e.to_status,
    actor_id: e.actor_id,
    reason: e.reason,
    created_at: toIso(e.created_at),
  })),
  messages: d.messages.map((m) => ({
    id: m.id,
    item_id: m.item_id,
    sender_id: m.sender_id,
    receiver_id: m.receiver_id,
    message: m.message,
    created_at: toIso(m.created_at),
  })),
});

export const toModerationResultDto = (r: {
  item: Item;
  cancelledNegotiation: boolean;
  resolvedReports: number;
}): ModerationResultDto => ({
  item_id: r.item.id,
  status: r.item.status,
  moderation_status: r.item.moderation_status,
  moderation_reason: r.item.moderation_reason,
  cancelled_negotiation: r.cancelledNegotiation,
  resolved_reports: r.resolvedReports,
});
