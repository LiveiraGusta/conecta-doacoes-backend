import type { Queryable } from '../../core/db';
import type {
  ChatMessage,
  ItemReportRow,
  Page,
  Report,
  ReportCategory,
  ReportKind,
  ReportParty,
  ReportResolution,
  ReportStatus,
  ReportSummary,
} from '../../types';

export interface NewReport {
  itemId: string;
  reporterId: string;
  reportedId: string;
  kind: ReportKind;
  category?: ReportCategory | null;
  reason?: string | null;
}

export const reportsRepository = {
  /**
   * Os índices únicos parciais barram a segunda denúncia aberta do mesmo usuário e tipo:
   * reports_open_per_reporter_key (CHAT → ALREADY_REPORTED) e
   * reports_open_item_per_reporter_key (ITEM → ITEM_ALREADY_REPORTED).
   */
  async insert(q: Queryable, r: NewReport): Promise<Report> {
    const [row] = await q<Report[]>`
      INSERT INTO reports (item_id, reporter_id, reported_id, kind, category, reason)
      VALUES (${r.itemId}, ${r.reporterId}, ${r.reportedId}, ${r.kind}, ${r.category ?? null}, ${r.reason ?? null})
      RETURNING *`;
    return row!;
  },

  /** Quantas pessoas diferentes têm denúncia de anúncio aberta sobre o item. */
  async countOpenItemReporters(q: Queryable, itemId: string): Promise<number> {
    const [row] = await q<{ n: number }[]>`
      SELECT count(DISTINCT reporter_id)::int AS n
      FROM reports WHERE item_id = ${itemId} AND kind = 'ITEM' AND status = 'ABERTA'`;
    return row?.n ?? 0;
  },

  /** Fila do Admin por status (e tipo, opcional), mais antigas primeiro. */
  async list(
    q: Queryable,
    f: { status: ReportStatus; kind?: ReportKind; limit: number; offset: number },
  ): Promise<Page<ReportSummary>> {
    const where = q`r.status = ${f.status} ${f.kind ? q`AND r.kind = ${f.kind}` : q``}`;
    const [count] = await q<{ total: number }[]>`SELECT count(*)::int AS total FROM reports r WHERE ${where}`;
    const rows = await q<ReportSummary[]>`
      SELECT r.id, r.kind, r.category, r.status, r.resolution, r.reason, r.created_at,
             i.id AS item_id, i.title AS item_title, i.status AS item_status,
             i.moderation_status AS item_moderation_status,
             ru.id AS reporter_id, ru.name AS reporter_name, ru.role AS reporter_role,
             du.id AS reported_id, du.name AS reported_name, du.role AS reported_role
      FROM reports r
      JOIN items i ON i.id = r.item_id
      JOIN users ru ON ru.id = r.reporter_id
      JOIN users du ON du.id = r.reported_id
      WHERE ${where}
      ORDER BY r.created_at ASC, r.id ASC
      LIMIT ${f.limit} OFFSET ${f.offset}`;
    return { total: count?.total ?? 0, rows };
  },

  async findById(q: Queryable, id: string): Promise<Report | null> {
    const [row] = await q<Report[]>`SELECT * FROM reports WHERE id = ${id}`;
    return row ?? null;
  },

  /** Usuários envolvidos, com e-mail e perfil de ONG (para o Admin agir sobre a conta). */
  async findParties(q: Queryable, ids: string[]): Promise<ReportParty[]> {
    return q<ReportParty[]>`
      SELECT u.id, u.name, u.role, u.email, np.id AS ngo_profile_id
      FROM users u
      LEFT JOIN ngo_profiles np ON np.user_id = u.id
      WHERE u.id IN ${q(ids)}`;
  },

  /** Todas as denúncias de anúncio do item, abertas e resolvidas, mais antigas primeiro. */
  async listItemReports(q: Queryable, itemId: string): Promise<ItemReportRow[]> {
    return q<ItemReportRow[]>`
      SELECT r.id, r.category, r.reason, r.status, r.created_at,
             u.id AS reporter_id, u.name AS reporter_name, u.role AS reporter_role
      FROM reports r JOIN users u ON u.id = r.reporter_id
      WHERE r.item_id = ${itemId} AND r.kind = 'ITEM'
      ORDER BY r.created_at ASC, r.id ASC`;
  },

  /** Todas as mensagens do item, de todas as negociações — sem o filtro por par do chat. */
  async listAllMessages(q: Queryable, itemId: string): Promise<ChatMessage[]> {
    return q<ChatMessage[]>`SELECT * FROM chat_messages WHERE item_id = ${itemId} ORDER BY created_at ASC, id ASC`;
  },

  /** Resolve só se ainda está aberta; null quando não existe ou já estava resolvida. */
  async resolveIfOpen(q: Queryable, id: string, adminId: string): Promise<Report | null> {
    const [row] = await q<Report[]>`
      UPDATE reports SET status = 'RESOLVIDA', resolved_at = NOW(), resolved_by = ${adminId}
      WHERE id = ${id} AND status = 'ABERTA'
      RETURNING *`;
    return row ?? null;
  },

  /** Resolve de uma vez as denúncias de anúncio abertas do item, com o desfecho da moderação. */
  async resolveOpenItemReports(
    q: Queryable,
    itemId: string,
    adminId: string,
    resolution: ReportResolution,
  ): Promise<number> {
    const rows = await q`
      UPDATE reports SET status = 'RESOLVIDA', resolution = ${resolution}, resolved_at = NOW(), resolved_by = ${adminId}
      WHERE item_id = ${itemId} AND kind = 'ITEM' AND status = 'ABERTA'
      RETURNING id`;
    return rows.length;
  },
};

export type ReportsRepository = typeof reportsRepository;
