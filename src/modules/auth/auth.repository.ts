import type { Queryable } from '../../core/db';
import type { AuthUser, NgoProfile, NgoStatus, Role, User, UserWithProfile } from '../../types';

const userWithProfile = (q: Queryable) => q`
  SELECT u.*, (SELECT to_jsonb(np) FROM ngo_profiles np WHERE np.user_id = u.id) AS ngo_profile
  FROM users u`;

export const authRepository = {
  /** Contexto mínimo do usuário para o hook de autenticação. */
  async findAuthContext(q: Queryable, userId: string): Promise<AuthUser | null> {
    const [row] = await q<{ id: string; role: Role; city: string; state: string; ngo_status: NgoStatus | null }[]>`
      SELECT u.id, u.role, u.city, u.state, np.status AS ngo_status
      FROM users u
      LEFT JOIN ngo_profiles np ON np.user_id = u.id
      WHERE u.id = ${userId}`;
    if (!row) return null;
    return { id: row.id, role: row.role, city: row.city, state: row.state, ngoStatus: row.ngo_status };
  },

  async findById(q: Queryable, id: string): Promise<UserWithProfile | null> {
    const [row] = await q<UserWithProfile[]>`${userWithProfile(q)} WHERE u.id = ${id}`;
    return row ?? null;
  },

  async findByEmail(q: Queryable, email: string): Promise<UserWithProfile | null> {
    const [row] = await q<UserWithProfile[]>`${userWithProfile(q)} WHERE u.email = ${email}`;
    return row ?? null;
  },

  async emailExists(q: Queryable, email: string): Promise<boolean> {
    const [row] = await q`SELECT 1 FROM users WHERE email = ${email}`;
    return Boolean(row);
  },

  async cnpjExists(q: Queryable, cnpj: string): Promise<boolean> {
    const [row] = await q`SELECT 1 FROM ngo_profiles WHERE cnpj = ${cnpj}`;
    return Boolean(row);
  },

  async insertUser(
    q: Queryable,
    u: { id?: string; name: string; email: string; password_hash: string; role: Role; city: string; state: string },
  ): Promise<User> {
    const [row] = await q<User[]>`
      INSERT INTO users (id, name, email, password_hash, role, city, state)
      VALUES (COALESCE(${u.id ?? null}::uuid, gen_random_uuid()), ${u.name}, ${u.email}, ${u.password_hash},
              ${u.role}, ${u.city}, ${u.state})
      RETURNING *`;
    return row!;
  },

  async insertNgoProfile(
    q: Queryable,
    p: { user_id: string; cnpj: string; website: string | null; document_url: string },
  ): Promise<NgoProfile> {
    const [row] = await q<NgoProfile[]>`
      INSERT INTO ngo_profiles (user_id, cnpj, website, document_url)
      VALUES (${p.user_id}, ${p.cnpj}, ${p.website}, ${p.document_url})
      RETURNING *`;
    return row!;
  },
};

export type AuthRepository = typeof authRepository;
