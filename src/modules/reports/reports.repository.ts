import type { Queryable } from '../../core/db';
import type { ChatMessage, Page, Report, ReportParty, ReportStatus, ReportSummary } from '../../types';

export const reportsRepository = {
  /** A constraint reports_open_per_reporter_key barra a segunda denúncia aberta (ALREADY_REPORTED). */
  async insert(q: Queryable, r: { itemId: string; reporterId: string; reportedId: string; reason: string }): Promise<Report> {
    const [row] = await q<Report[]>`
      INSERT INTO reports (item_id, reporter_id, reported_id, reason)
      VALUES (${r.itemId}, ${r.reporterId}, ${r.reportedId}, ${r.reason})
      RETURNING *`;
    return row!;
  },

  /** Fila do Admin por status, mais antigas primeiro. */
  async list(q: Queryable, f: { status: ReportStatus; limit: number; offset: number }): Promise<Page<ReportSummary>> {
    const [count] = await q<{ total: number }[]>`SELECT count(*)::int AS total FROM reports WHERE status = ${f.status}`;
    const rows = await q<ReportSummary[]>`
      SELECT r.id, r.status, r.reason, r.created_at,
             i.id AS item_id, i.title AS item_title, i.status AS item_status,
             ru.id AS reporter_id, ru.name AS reporter_name, ru.role AS reporter_role,
             du.id AS reported_id, du.name AS reported_name, du.role AS reported_role
      FROM reports r
      JOIN items i ON i.id = r.item_id
      JOIN users ru ON ru.id = r.reporter_id
      JOIN users du ON du.id = r.reported_id
      WHERE r.status = ${f.status}
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
};

export type ReportsRepository = typeof reportsRepository;
