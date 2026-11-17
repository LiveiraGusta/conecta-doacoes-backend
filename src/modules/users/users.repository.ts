import type { Queryable } from '../../core/db';
import type { UserProfileRow } from '../../types';

export const usersRepository = {
  /**
   * Dados da página pessoal: usuário ativo (DONOR ou NGO), perfil de ONG, preferência de privacidade
   * e a contagem de doações concluídas (doadas, para o doador; recebidas, para a ONG).
   * Admin e conta excluída não têm página: devolve null.
   */
  async findProfile(q: Queryable, userId: string): Promise<UserProfileRow | null> {
    const [row] = await q<UserProfileRow[]>`
      SELECT u.id, u.name, u.role, u.city, u.state, u.bio, u.avatar_url, u.created_at,
             np.status AS ngo_status, np.website, np.banner_url, np.phone, np.instagram,
             COALESCE(np.accepted_categories, '{}') AS accepted_categories,
             np.cep, np.street, np.number, np.complement, np.neighborhood,
             COALESCE(up.show_donations, FALSE) AS show_donations,
             (SELECT count(*)::int FROM items i
              WHERE i.status = 'DOADO'
                AND (CASE WHEN u.role = 'DONOR' THEN i.donor_id ELSE i.selected_ngo_id END) = u.id) AS donations_count
      FROM users u
      LEFT JOIN ngo_profiles np ON np.user_id = u.id
      LEFT JOIN user_preferences up ON up.user_id = u.id
      WHERE u.id = ${userId} AND u.deleted_at IS NULL AND u.role IN ('DONOR', 'NGO')`;
    return row ?? null;
  },
};

export type UsersRepository = typeof usersRepository;
