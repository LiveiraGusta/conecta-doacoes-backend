import type { Queryable } from '../../core/db';
import type { Category, UserPreferences } from '../../types';

/** Campos da ONG gravados pelo PATCH /profile (undefined = não mexe). */
export interface NgoProfilePatch {
  phone?: string | null;
  instagram?: string | null;
  accepted_categories?: Category[];
  cep?: string | null;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  neighborhood?: string | null;
}

export const profileRepository = {
  async updateUser(q: Queryable, userId: string, f: { name?: string; city?: string; state?: string }): Promise<void> {
    await q`
      UPDATE users SET
        name = COALESCE(${f.name ?? null}, name),
        city = COALESCE(${f.city ?? null}, city),
        state = COALESCE(${f.state ?? null}, state),
        updated_at = NOW()
      WHERE id = ${userId}`;
  },

  async updateWebsite(q: Queryable, userId: string, website: string | null): Promise<void> {
    await q`UPDATE ngo_profiles SET website = ${website} WHERE user_id = ${userId}`;
  },

  async updateBio(q: Queryable, userId: string, bio: string | null): Promise<void> {
    await q`UPDATE users SET bio = ${bio}, updated_at = NOW() WHERE id = ${userId}`;
  },

  async updateNgoProfile(q: Queryable, userId: string, patch: NgoProfilePatch): Promise<void> {
    const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const columns = Object.keys(fields);
    if (columns.length === 0) return;
    await q`UPDATE ngo_profiles SET ${q(fields, columns)} WHERE user_id = ${userId}`;
  },

  async upsertPreferences(q: Queryable, userId: string, p: UserPreferences): Promise<UserPreferences> {
    const [row] = await q<UserPreferences[]>`
      INSERT INTO user_preferences (user_id, theme_color, theme_mode, show_donations)
      VALUES (${userId}, ${p.theme_color}, ${p.theme_mode}, ${p.show_donations})
      ON CONFLICT (user_id) DO UPDATE SET
        theme_color = EXCLUDED.theme_color,
        theme_mode = EXCLUDED.theme_mode,
        show_donations = EXCLUDED.show_donations,
        updated_at = NOW()
      RETURNING theme_color, theme_mode, show_donations`;
    return row!;
  },

  /** Grava o novo hash e marca a troca: tokens emitidos antes passam a ser recusados. */
  /**
   * Troca o documento e devolve a ONG para análise, exceto se ela já estiver ATIVO.
   * Precisa de transação: trava o perfil, lê o caminho antigo e atualiza.
   */
  async replaceDocumentUnlessActive(
    q: Queryable,
    userId: string,
    newPath: string,
  ): Promise<{ replaced: true; oldPath: string } | { replaced: false; isActive: boolean }> {
    const [current] = await q<{ document_url: string; status: string }[]>`
      SELECT document_url, status FROM ngo_profiles WHERE user_id = ${userId} FOR UPDATE`;
    if (!current || current.status === 'ATIVO') return { replaced: false, isActive: current?.status === 'ATIVO' };
    await q`
      UPDATE ngo_profiles SET document_url = ${newPath}, status = 'PENDENTE_APROVACAO', rejection_reason = NULL
      WHERE user_id = ${userId}`;
    return { replaced: true, oldPath: current.document_url };
  },

  async hasActiveNegotiations(q: Queryable, userId: string): Promise<boolean> {
    const [row] = await q`
      SELECT 1 FROM items
      WHERE status = 'EM_PROGRESSO' AND (donor_id = ${userId} OR selected_ngo_id = ${userId})
      LIMIT 1`;
    return Boolean(row);
  },

  /** Itens DISPONIVEL do doador saem de vez (com fotos, curtidas e eventos). Devolve as URLs das fotos. */
  async deleteAvailableItemsOfDonor(q: Queryable, donorId: string): Promise<string[]> {
    const photos = await q<{ photo_url: string }[]>`
      SELECT p.photo_url FROM item_photos p JOIN items i ON i.id = p.item_id
      WHERE i.donor_id = ${donorId} AND i.status = 'DISPONIVEL'`;
    await q`DELETE FROM items WHERE donor_id = ${donorId} AND status = 'DISPONIVEL'`;
    return photos.map((p) => p.photo_url);
  },

  /** Curtidas da ONG em itens ainda disponíveis somem, para o doador não escolher uma conta removida. */
  async deleteOpenInterestsOfNgo(q: Queryable, ngoId: string): Promise<void> {
    await q`
      DELETE FROM item_interests ii USING items i
      WHERE ii.item_id = i.id AND ii.ngo_id = ${ngoId} AND i.status = 'DISPONIVEL'`;
  },

  /** Remove o perfil de ONG (libera o CNPJ) e devolve o caminho do documento para apagar do Storage. */
  async deleteNgoProfile(q: Queryable, userId: string): Promise<string | null> {
    const [row] = await q<{ document_url: string }[]>`
      DELETE FROM ngo_profiles WHERE user_id = ${userId} RETURNING document_url`;
    return row?.document_url ?? null;
  },

  /** Anonimiza a conta: histórico de doações e conversas continua íntegro para o Admin. */
  async anonymize(q: Queryable, userId: string): Promise<void> {
    await q`
      UPDATE users SET
        name = 'Usuário removido',
        email = 'removido+' || id || '@conectadoacoes.invalid',
        password_hash = '!',
        deleted_at = NOW(),
        updated_at = NOW()
      WHERE id = ${userId}`;
    // Links de redefinição pendentes deixam de valer.
    await q`DELETE FROM password_resets WHERE user_id = ${userId}`;
  },
};

export type ProfileRepository = typeof profileRepository;
