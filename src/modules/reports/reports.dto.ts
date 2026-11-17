import { z } from 'zod';
import { isoDate, PaginationQuery, text, toIso } from '../../core/dto';
import type { ChatMessage, Item, ItemEvent, Page, Report, ReportParty, ReportSummary, Role } from '../../types';

// ── Entrada ──
export const CreateReportBody = z.object({ reason: text(10, 1000) });
export type CreateReportBody = z.infer<typeof CreateReportBody>;

const ReportStatus = z.enum(['ABERTA', 'RESOLVIDA']);

export const ListReportsQuery = PaginationQuery.extend({ status: ReportStatus.default('ABERTA') });
export type ListReportsQuery = z.infer<typeof ListReportsQuery>;

export const ReportIdParams = z.object({ reportId: z.uuid() });
export type ReportIdParams = z.infer<typeof ReportIdParams>;

export const ResolveReportBody = z.object({ status: z.literal('RESOLVIDA') });
export type ResolveReportBody = z.infer<typeof ResolveReportBody>;

// ── Saída ──
const PartyRole = z.enum(['DONOR', 'NGO']);
const ItemStatus = z.enum(['DISPONIVEL', 'EM_PROGRESSO', 'DOADO']);
const Party = z.object({ id: z.uuid(), name: z.string(), role: PartyRole });

export const ReportDto = z
  .object({
    id: z.uuid(),
    item_id: z.uuid(),
    reporter_id: z.uuid(),
    reported_id: z.uuid(),
    reason: z.string(),
    status: ReportStatus,
    created_at: isoDate(),
  })
  .describe('Report');
export type ReportDto = z.infer<typeof ReportDto>;

export const ReportSummaryDto = z
  .object({
    id: z.uuid(),
    status: ReportStatus,
    reason: z.string(),
    created_at: isoDate(),
    item: z.object({ id: z.uuid(), title: z.string(), status: ItemStatus }),
    reporter: Party,
    reported: Party,
  })
  .describe('ReportSummary');

export const ReportListDto = z.object({ total: z.number().int().min(0), data: z.array(ReportSummaryDto) });
export type ReportListDto = z.infer<typeof ReportListDto>;

export const ReportDetailDto = z
  .object({
    report: z.object({ id: z.uuid(), status: ReportStatus, reason: z.string(), created_at: isoDate() }),
    item: z.object({
      id: z.uuid(),
      title: z.string(),
      status: ItemStatus,
      donor_id: z.uuid(),
      selected_ngo_id: z.uuid().nullable(),
    }),
    reporter: Party.extend({ email: z.string() }),
    reported: Party.extend({ email: z.string(), ngo_profile_id: z.uuid().nullable() }),
    events: z.array(
      z.object({
        from_status: z.string().nullable(),
        to_status: z.string(),
        actor_id: z.uuid().nullable(),
        reason: z.string().nullable(),
        created_at: isoDate(),
      }),
    ),
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

// ── Mapeamento ──
const party = (role: Role) => role as z.infer<typeof PartyRole>;

export const toReportDto = (r: Report): ReportDto => ({
  id: r.id,
  item_id: r.item_id,
  reporter_id: r.reporter_id,
  reported_id: r.reported_id,
  reason: r.reason,
  status: r.status,
  created_at: toIso(r.created_at),
});

export const toReportListDto = (page: Page<ReportSummary>): ReportListDto => ({
  total: page.total,
  data: page.rows.map((r) => ({
    id: r.id,
    status: r.status,
    reason: r.reason,
    created_at: toIso(r.created_at),
    item: { id: r.item_id, title: r.item_title, status: r.item_status },
    reporter: { id: r.reporter_id, name: r.reporter_name, role: party(r.reporter_role) },
    reported: { id: r.reported_id, name: r.reported_name, role: party(r.reported_role) },
  })),
});

const toPartyDto = (p: ReportParty) => ({ id: p.id, name: p.name, role: party(p.role), email: p.email });

export const toReportDetailDto = (d: {
  report: Report;
  item: Item;
  reporter: ReportParty;
  reported: ReportParty;
  events: ItemEvent[];
  messages: ChatMessage[];
}): ReportDetailDto => ({
  report: { id: d.report.id, status: d.report.status, reason: d.report.reason, created_at: toIso(d.report.created_at) },
  item: {
    id: d.item.id,
    title: d.item.title,
    status: d.item.status,
    donor_id: d.item.donor_id,
    selected_ngo_id: d.item.selected_ngo_id,
  },
  reporter: toPartyDto(d.reporter),
  reported: { ...toPartyDto(d.reported), ngo_profile_id: d.reported.ngo_profile_id },
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
