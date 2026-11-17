import type { Db } from '../../core/db';
import { AppError } from '../../core/errors';
import type { AuthUser, Page, UserProfileRow, UserProfileView } from '../../types';
import type { ItemsService, ViewedItem } from '../items/items.service';
import type { UsersRepository } from './users.repository';

export interface UsersDeps {
  db: Pick<Db, 'sql'>;
  usersRepo: UsersRepository;
  items: Pick<ItemsService, 'donatedBy' | 'receivedBy'>;
}

export const createUsersService = ({ db, usersRepo, items }: UsersDeps) => {
  async function load(userId: string): Promise<UserProfileRow> {
    const row = await usersRepo.findProfile(db.sql, userId);
    if (!row) throw new AppError('USER_NOT_FOUND');
    return row;
  }

  const isHidden = (row: UserProfileRow, viewerId: string | null) =>
    row.role === 'DONOR' && !row.show_donations && row.id !== viewerId;

  return {
    async profile(viewer: AuthUser, userId: string): Promise<UserProfileView> {
      const row = await load(userId);
      return {
        row,
        donationsHidden: isHidden(row, viewer.id),
        showNgoContact: row.role === 'NGO' && (row.ngo_status === 'ATIVO' || row.id === viewer.id),
      };
    },

    /**
     * Doador: as doações concluídas, se ele escolheu mostrar (ou se é ele mesmo).
     * ONG: os itens que ela recebeu. Oculto não revela se existem doações.
     */
    async donations(
      viewer: AuthUser,
      userId: string,
      page: { limit: number; offset: number },
    ): Promise<Page<ViewedItem> & { hidden: boolean }> {
      const row = await load(userId);
      if (isHidden(row, viewer.id)) return { total: 0, rows: [], hidden: true };
      const result =
        row.role === 'DONOR' ? await items.donatedBy(viewer, row.id, page) : await items.receivedBy(viewer, row.id, page);
      return { ...result, hidden: false };
    },

    /** Visitante: só ONG ATIVO e doadores; o DTO público tira nome, foto e contatos. */
    async publicProfile(userId: string): Promise<{ row: UserProfileRow; donationsHidden: boolean }> {
      const row = await load(userId);
      if (row.role === 'NGO' && row.ngo_status !== 'ATIVO') throw new AppError('USER_NOT_FOUND');
      return { row, donationsHidden: isHidden(row, null) };
    },
  };
};

export type UsersService = ReturnType<typeof createUsersService>;
