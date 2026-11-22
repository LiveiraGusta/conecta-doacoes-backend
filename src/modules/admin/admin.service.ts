import type { Db } from '../../core/db';
import { AppError } from '../../core/errors';
import type { Storage } from '../../core/storage';
import type { NgoProfile, NgoStatus } from '../../types';
import { noopNotifier, type Notifier } from '../notifications/notifications.service';
import type { AdminNgo } from './admin.dto';
import type { AdminRepository } from './admin.repository';

export interface AdminDeps {
  db: Pick<Db, 'sql'>;
  adminRepo: AdminRepository;
  storage: Storage;
  /** Avisa a ONG da aprovação ou da rejeição (com o motivo). */
  notifier?: Notifier;
}

const SIGNED_URL_TTL_SEC = 10 * 60;

export const createAdminService = ({ db, adminRepo, storage, notifier = noopNotifier }: AdminDeps) => ({
  async listNgos(f: { status: NgoStatus; limit: number; offset: number }): Promise<{ total: number; data: AdminNgo[] }> {
    const { total, rows } = await adminRepo.listNgos(db.sql, f);
    const data = await Promise.all(
      rows.map(async ({ document_path, ...row }) => ({
        ...row,
        document_url: await storage.signedUrl(document_path, SIGNED_URL_TTL_SEC),
      })),
    );
    return { total, data };
  },

  /**
   * Aprova ou rejeita (pode ser chamada de novo para mudar a decisão).
   * Rejeitar uma ONG em negociação não cancela a negociação.
   */
  async updateNgoStatus(id: string, status: 'ATIVO' | 'REJEITADO', rejectionReason?: string): Promise<NgoProfile> {
    const reason = status === 'REJEITADO' ? (rejectionReason ?? null) : null;
    const profile = await adminRepo.updateNgoStatus(db.sql, id, status, reason);
    if (!profile) throw new AppError('NGO_NOT_FOUND');
    notifier.notify(
      status === 'ATIVO'
        ? { type: 'ngo.approved', userId: profile.user_id }
        : { type: 'ngo.rejected', userId: profile.user_id, reason },
    );
    return profile;
  },
});

export type AdminService = ReturnType<typeof createAdminService>;
