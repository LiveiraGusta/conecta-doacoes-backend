import type { Queryable } from '../../core/db';
import type { Role } from '../../types';

/** Destinatário de um e-mail. Contas excluídas (anonimizadas) nunca aparecem. */
export interface Contact {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface ItemRef {
  id: string;
  title: string;
  donor_id: string;
}

export const notificationsRepository = {
  async findContacts(q: Queryable, ids: string[]): Promise<Contact[]> {
    if (ids.length === 0) return [];
    return q<Contact[]>`
      SELECT id, name, email, role FROM users
      WHERE id IN ${q(ids)} AND deleted_at IS NULL`;
  },

  async findAdmins(q: Queryable): Promise<Contact[]> {
    return q<Contact[]>`
      SELECT id, name, email, role FROM users
      WHERE role = 'ADMIN' AND deleted_at IS NULL
      ORDER BY created_at`;
  },

  async findItem(q: Queryable, id: string): Promise<ItemRef | null> {
    const [row] = await q<ItemRef[]>`SELECT id, title, donor_id FROM items WHERE id = ${id}`;
    return row ?? null;
  },
};

export type NotificationsRepository = typeof notificationsRepository;
