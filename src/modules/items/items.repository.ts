import type { Queryable } from '../../core/db';
import type { Category, Item, ItemPhoto, ItemStatus, ItemView, Page } from '../../types';

export type { ItemView, Page };

export interface FeedFilter {
  city: string;
  state: string;
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

  /** Feed da região: DISPONIVEL e EM_PROGRESSO, mais novos primeiro. */
  async findFeed(q: Queryable, f: FeedFilter): Promise<Page<ItemView>> {
    const where = q`
      i.state = ${f.state} AND i.city = ${f.city}
      AND i.status IN ('DISPONIVEL', 'EM_PROGRESSO')
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

  /** Itens que a ONG curtiu (inclui os que ela negocia ou recebeu), mais recentes primeiro. */
  async findInterestedBy(
    q: Queryable,
    f: { ngoId: string; status?: ItemStatus; limit: number; offset: number },
  ): Promise<Page<ItemView>> {
    const where = q`
      EXISTS (SELECT 1 FROM item_interests mine WHERE mine.item_id = i.id AND mine.ngo_id = ${f.ngoId})
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
};

export type ItemsRepository = typeof itemsRepository;
