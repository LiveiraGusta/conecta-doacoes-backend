import type { Queryable } from '../../core/db';
import type { NgoProfile, NgoStatus } from '../../types';

export interface AdminNgoRow {
  ngo_profile_id: string;
  user_id: string;
  name: string;
  email: string;
  city: string;
  state: string;
  cnpj: string;
  website: string | null;
  /** Caminho no bucket privado; o service troca por URL assinada. */
  document_path: string;
  status: NgoStatus;
  rejection_reason: string | null;
  created_at: Date;
}

export const adminRepository = {
  /** ONGs por status, mais antigas primeiro (fila em ordem de chegada). */
  async listNgos(
    q: Queryable,
    f: { status: NgoStatus; limit: number; offset: number },
  ): Promise<{ total: number; rows: AdminNgoRow[] }> {
    const [count] = await q<{ total: number }[]>`
      SELECT count(*)::int AS total FROM ngo_profiles WHERE status = ${f.status}`;
    const rows = await q<AdminNgoRow[]>`
      SELECT np.id AS ngo_profile_id, u.id AS user_id, u.name, u.email, u.city, u.state,
             np.cnpj, np.website, np.document_url AS document_path, np.status, np.rejection_reason, u.created_at
      FROM ngo_profiles np
      JOIN users u ON u.id = np.user_id
      WHERE np.status = ${f.status}
      ORDER BY u.created_at ASC, np.id ASC
      LIMIT ${f.limit} OFFSET ${f.offset}`;
    return { total: count?.total ?? 0, rows };
  },

  async updateNgoStatus(
    q: Queryable,
    id: string,
    status: NgoStatus,
    rejectionReason: string | null,
  ): Promise<NgoProfile | null> {
    const [row] = await q<NgoProfile[]>`
      UPDATE ngo_profiles SET status = ${status}, rejection_reason = ${rejectionReason}
      WHERE id = ${id}
      RETURNING *`;
    return row ?? null;
  },
};

export type AdminRepository = typeof adminRepository;
