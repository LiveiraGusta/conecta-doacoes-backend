import type { Queryable } from '../../core/db';
import type { Category, Item, ItemPhoto, ItemStatus, ItemView, ModerationStatus, Page } from '../../types';

export type { ItemView, Page };

export interface FeedFilter {
  /** Ausente = todas as cidades (visitante). */
  city?: string;
  state?: string;
  category?: Category;
  search?: string;
  viewerId: string;
  limit: number;
  offset: number;
}

/** Escapa os curingas do ILIKE: o termo buscado é literal. */
const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const viewColumns = (q: Queryable, viewerId: string) => q`
  i.*,
  u.name AS donor_name,
  u.avatar_url AS donor_avatar_url,
  ARRAY(SELECT p.photo_url FROM item_photos p WHERE p.item_id = i.id ORDER BY p.created_at, p.id) AS photos,
  ARRAY(SELECT p.id FROM item_photos p WHERE p.item_id = i.id ORDER BY p.created_at, p.id) AS photo_ids,
  (SELECT count(*)::int FROM item_interests ii WHERE ii.item_id = i.id) AS interests_count,
  EXISTS (SELECT 1 FROM item_interests ii WHERE ii.item_id = i.id AND ii.ngo_id = ${viewerId}) AS has_user_interest`;

export const itemsRepository = {
  /** Item + fotos na ordem dada. A primeira foto recebe o menor created_at. */
  async insertWithPhotos(
    q: Queryable,
    item: Pick<Item, 'id' | 'donor_id' | 'title' | 'description' | 'notes' | 'category' | 'city' | 'state'>,
    photoUrls: string[],
  ): Promise<Item & { photos: ItemPhoto[] }> {
    const [row] = await q<Item[]>`
      INSERT INTO items (id, donor_id, title, description, notes, category, city, state)
      VALUES (${item.id}, ${item.donor_id}, ${item.title}, ${item.description}, ${item.notes}, ${item.category},
              ${item.city}, ${item.state})
      RETURNING *`;
    const photos = await q<ItemPhoto[]>`
      INSERT INTO item_photos (item_id, photo_url, created_at)
      SELECT ${item.id}::uuid, url, NOW() + ((ord - 1) * interval '1 millisecond')
      FROM unnest(${photoUrls}::text[]) WITH ORDINALITY AS t(url, ord)
      RETURNING *`;
    photos.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    return { ...row!, photos: [...photos] };
  },

  /**
   * DISPONIVEL → EM_PROGRESSO num único UPDATE condicional: só passa se o item é do doador,
   * está disponível, a ONG curtiu e está ATIVO. Duas escolhas simultâneas: a segunda vê 0 linhas.
   */
  async selectNgoIfAvailable(q: Queryable, itemId: string, donorId: string, ngoId: string): Promise<Item | null> {
    const [row] = await q<Item[]>`
      UPDATE items i SET status = 'EM_PROGRESSO', selected_ngo_id = ${ngoId}
      WHERE i.id = ${itemId} AND i.donor_id = ${donorId} AND i.status = 'DISPONIVEL'
        AND i.moderation_status = 'VISIVEL'
        AND EXISTS (SELECT 1 FROM item_interests WHERE item_id = ${itemId} AND ngo_id = ${ngoId})
        AND EXISTS (SELECT 1 FROM ngo_profiles WHERE user_id = ${ngoId} AND status = 'ATIVO')
      RETURNING i.*`;
    return row ?? null;
  },

  /** EM_PROGRESSO → DOADO, só pela ONG selecionada. DOADO é final. */
  async confirmIfInProgress(q: Queryable, itemId: string, ngoId: string): Promise<Item | null> {
    const [row] = await q<Item[]>`
      UPDATE items SET status = 'DOADO', completed_at = NOW()
      WHERE id = ${itemId} AND status = 'EM_PROGRESSO' AND selected_ngo_id = ${ngoId}
      RETURNING *`;
    return row ?? null;
  },

  /**
   * EM_PROGRESSO → DISPONIVEL pelo doador ou pela ONG selecionada; limpa selected_ngo_id.
   * Devolve o item atualizado e a ONG que estava negociando (para o evento).
   *
   * Precisa rodar dentro de transação: trava a linha e lê a ONG atual antes do UPDATE.
   * (O CTE com FOR UPDATE da Spec do Backend devolve NULL: a leitura com lock segue a
   * versão já atualizada da linha.)
   */
  async cancelIfInProgress(
    q: Queryable,
    itemId: string,
    userId: string,
  ): Promise<(Item & { previous_ngo_id: string }) | null> {
    const [locked] = await q<{ selected_ngo_id: string | null }[]>`
      SELECT selected_ngo_id FROM items WHERE id = ${itemId} FOR UPDATE`;
    if (!locked?.selected_ngo_id) return null;

    const [row] = await q<Item[]>`
      UPDATE items SET status = 'DISPONIVEL', selected_ngo_id = NULL
      WHERE id = ${itemId} AND status = 'EM_PROGRESSO' AND (donor_id = ${userId} OR selected_ngo_id = ${userId})
      RETURNING *`;
    return row ? { ...row, previous_ngo_id: locked.selected_ngo_id } : null;
  },

  async findById(q: Queryable, id: string): Promise<Item | null> {
    const [row] = await q<Item[]>`SELECT * FROM items WHERE id = ${id}`;
    return row ?? null;
  },

  async findView(q: Queryable, id: string, viewerId: string): Promise<ItemView | null> {
    const [row] = await q<ItemView[]>`
      SELECT ${viewColumns(q, viewerId)}
      FROM items i JOIN users u ON u.id = i.donor_id
      WHERE i.id = ${id}`;
    return row ?? null;
  },

  /**
   * Feed: DISPONIVEL e EM_PROGRESSO, só VISIVEL na moderação, mais novos primeiro. Com cidade/UF, só a região (usuário logado);
   * sem, todas as cidades (visitante).
   */
  async findFeed(q: Queryable, f: FeedFilter): Promise<Page<ItemView>> {
    const where = q`
      i.status IN ('DISPONIVEL', 'EM_PROGRESSO') AND i.moderation_status = 'VISIVEL'
      ${f.city && f.state ? q`AND i.state = ${f.state} AND i.city = ${f.city}` : q``}
      ${f.category ? q`AND i.category = ${f.category}` : q``}
      ${f.search ? q`AND (i.title ILIKE ${likePattern(f.search)} OR i.description ILIKE ${likePattern(f.search)})` : q``}`;

    const [count] = await q<{ total: number }[]>`SELECT count(*)::int AS total FROM items i WHERE ${where}`;
    const rows = await q<ItemView[]>`
      SELECT ${viewColumns(q, f.viewerId)}
      FROM items i JOIN users u ON u.id = i.donor_id
      WHERE ${where}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT ${f.limit} OFFSET ${f.offset}`;
    return { total: count?.total ?? 0, rows };
  },

  /** Doações do doador (todos os status, ou um só). */
  async findByDonor(
    q: Queryable,
    f: { donorId: string; status?: ItemStatus; limit: number; offset: number },
  ): Promise<Page<ItemView>> {
    const where = q`i.donor_id = ${f.donorId} ${f.status ? q`AND i.status = ${f.status}` : q``}`;
    const [count] = await q<{ total: number }[]>`SELECT count(*)::int AS total FROM items i WHERE ${where}`;
    const rows = await q<ItemView[]>`
      SELECT ${viewColumns(q, f.donorId)}
      FROM items i JOIN users u ON u.id = i.donor_id
      WHERE ${where}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT ${f.limit} OFFSET ${f.offset}`;
    return { total: count?.total ?? 0, rows };
  },

  /** Doações concluídas de um doador ou recebidas por uma ONG, das mais recentes para as mais antigas. */
  async findDonated(
    q: Queryable,
    f: { donorId?: string; ngoId?: string; viewerId: string; limit: number; offset: number },
  ): Promise<Page<ItemView>> {
    const where = q`
      i.status = 'DOADO' AND i.moderation_status = 'VISIVEL'
      ${f.donorId ? q`AND i.donor_id = ${f.donorId}` : q``}
      ${f.ngoId ? q`AND i.selected_ngo_id = ${f.ngoId}` : q``}`;
    const [count] = await q<{ total: number }[]>`SELECT count(*)::int AS total FROM items i WHERE ${where}`;
    const rows = await q<ItemView[]>`
      SELECT ${viewColumns(q, f.viewerId)}
      FROM items i JOIN users u ON u.id = i.donor_id
      WHERE ${where}
      ORDER BY i.completed_at DESC NULLS LAST, i.id DESC
      LIMIT ${f.limit} OFFSET ${f.offset}`;
    return { total: count?.total ?? 0, rows };
  },

  /**
   * Itens que a ONG curtiu (inclui os que ela negocia ou recebeu), mais recentes primeiro.
   * Anúncio oculto ou removido pela moderação some, salvo para a ONG escolhida.
   */
  async findInterestedBy(
    q: Queryable,
    f: { ngoId: string; status?: ItemStatus; limit: number; offset: number },
  ): Promise<Page<ItemView>> {
    const where = q`
      EXISTS (SELECT 1 FROM item_interests mine WHERE mine.item_id = i.id AND mine.ngo_id = ${f.ngoId})
      AND (i.moderation_status = 'VISIVEL' OR i.selected_ngo_id = ${f.ngoId})
      ${f.status ? q`AND i.status = ${f.status}` : q``}`;
    const [count] = await q<{ total: number }[]>`SELECT count(*)::int AS total FROM items i WHERE ${where}`;
    const rows = await q<ItemView[]>`
      SELECT ${viewColumns(q, f.ngoId)}
      FROM items i JOIN users u ON u.id = i.donor_id
      WHERE ${where}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT ${f.limit} OFFSET ${f.offset}`;
    return { total: count?.total ?? 0, rows };
  },

  // ── Moderação ──
  /** Trava a linha do item até o fim da transação (serializa denúncias e ações do Admin sobre ele). */
  async lockById(q: Queryable, id: string): Promise<Item | null> {
    const [row] = await q<Item[]>`SELECT * FROM items WHERE id = ${id} FOR UPDATE`;
    return row ?? null;
  },

  /** VISIVEL → OCULTO (ocultação automática por denúncias). null se não estava visível. */
  async hideIfVisible(q: Queryable, id: string): Promise<Item | null> {
    const [row] = await q<Item[]>`
      UPDATE items SET moderation_status = 'OCULTO', moderated_at = NOW(), moderated_by = NULL
      WHERE id = ${id} AND moderation_status = 'VISIVEL'
      RETURNING *`;
    return row ?? null;
  },

  /**
   * Muda a moderação pelo Admin. Ao remover um item EM_PROGRESSO, a negociação é desfeita no mesmo
   * UPDATE (volta a DISPONIVEL sem ONG). No SET, `status` é o valor antigo da linha.
   */
  async setModeration(
    q: Queryable,
    id: string,
    m: { status: Exclude<ModerationStatus, 'OCULTO'>; reason: string | null; adminId: string },
  ): Promise<Item | null> {
    const undoNegotiation =
      m.status === 'REMOVIDO'
        ? q`,
          status = CASE WHEN status = 'EM_PROGRESSO' THEN 'DISPONIVEL' ELSE status END,
          selected_ngo_id = CASE WHEN status = 'EM_PROGRESSO' THEN NULL ELSE selected_ngo_id END`
        : q``;
    const [row] = await q<Item[]>`
      UPDATE items SET
        moderation_status = ${m.status}, moderation_reason = ${m.reason},
        moderated_at = NOW(), moderated_by = ${m.adminId}
        ${undoNegotiation}
      WHERE id = ${id}
      RETURNING *`;
    return row ?? null;
  },
};

export type ItemsRepository = typeof itemsRepository;
