import type { Queryable } from '../../core/db';
import type { InterestedNgo, ItemInterest } from '../../types';

export type { InterestedNgo };

export const interestsRepository = {
  /**
   * Curtida atômica: só insere se o item existe, está DISPONIVEL e é da cidade/UF da ONG.
   * Like duplicado estoura a constraint única (→ 409 ALREADY_INTERESTED no handler).
   */
  async insertIfAvailable(
    q: Queryable,
    f: { itemId: string; ngoId: string; city: string; state: string },
  ): Promise<ItemInterest | null> {
    const [row] = await q<ItemInterest[]>`
      INSERT INTO item_interests (item_id, ngo_id)
      SELECT i.id, ${f.ngoId}
      FROM items i
      WHERE i.id = ${f.itemId} AND i.status = 'DISPONIVEL' AND i.city = ${f.city} AND i.state = ${f.state}
      RETURNING *`;
    return row ?? null;
  },

  async exists(q: Queryable, itemId: string, ngoId: string): Promise<boolean> {
    const [row] = await q`SELECT 1 FROM item_interests WHERE item_id = ${itemId} AND ngo_id = ${ngoId}`;
    return Boolean(row);
  },

  /** Desfaz a curtida, exceto se a ONG for a selecionada do item. Devolve se apagou. */
  async deleteUnlessSelected(q: Queryable, itemId: string, ngoId: string): Promise<boolean> {
    const rows = await q`
      DELETE FROM item_interests ii
      WHERE ii.item_id = ${itemId} AND ii.ngo_id = ${ngoId}
        AND NOT EXISTS (SELECT 1 FROM items i WHERE i.id = ${itemId} AND i.selected_ngo_id = ${ngoId})
      RETURNING ii.id`;
    return rows.length > 0;
  },

  /** ONGs que curtiram o item: ATIVO primeiro, depois por data da curtida. */
  async listByItem(q: Queryable, itemId: string): Promise<InterestedNgo[]> {
    return q<InterestedNgo[]>`
      SELECT ii.id AS interest_id, u.id AS ngo_id, u.name, u.avatar_url, u.city, u.state,
             np.cnpj, np.website, np.status AS ngo_status, ii.created_at AS liked_at
      FROM item_interests ii
      JOIN users u ON u.id = ii.ngo_id
      JOIN ngo_profiles np ON np.user_id = ii.ngo_id
      WHERE ii.item_id = ${itemId}
      ORDER BY (np.status = 'ATIVO') DESC, ii.created_at ASC, ii.id ASC`;
  },
};

export type InterestsRepository = typeof interestsRepository;
