import type { Db } from '../../core/db';
import { AppError } from '../../core/errors';
import type { AuthUser, Item, ItemInterest } from '../../types';
import type { ItemEventsRepository } from '../items/item-events.repository';
import type { ItemsRepository } from '../items/items.repository';
import type { InterestedNgo, InterestsRepository } from './interests.repository';

export interface InterestsDeps {
  db: Pick<Db, 'sql' | 'tx'>;
  itemsRepo: Pick<ItemsRepository, 'findById' | 'selectNgoIfAvailable'>;
  interestsRepo: InterestsRepository;
  eventsRepo: Pick<ItemEventsRepository, 'insert'>;
}

export const createInterestsService = ({ db, itemsRepo, interestsRepo, eventsRepo }: InterestsDeps) => ({
  /** Curtida de ONG ativa (o guard da rota já garantiu ATIVO). */
  async like(ngo: AuthUser, itemId: string): Promise<ItemInterest> {
    const created = await interestsRepo.insertIfAvailable(db.sql, {
      itemId,
      ngoId: ngo.id,
      city: ngo.city,
      state: ngo.state,
    });
    if (created) return created;

    // Nada inserido: descobrir o motivo. A ONG não vê itens de fora no feed,
    // mas o itemId pode vir de qualquer lugar, então a região é checada de novo aqui.
    const item = await itemsRepo.findById(db.sql, itemId);
    if (!item) throw new AppError('ITEM_NOT_FOUND');
    if (item.city !== ngo.city || item.state !== ngo.state) throw new AppError('OUT_OF_REGION');
    if (await interestsRepo.exists(db.sql, itemId, ngo.id)) throw new AppError('ALREADY_INTERESTED');
    throw new AppError('ITEM_NOT_AVAILABLE');
  },

  /** Desfaz a curtida. A ONG já escolhida precisa cancelar a negociação em vez disso. */
  async unlike(ngo: AuthUser, itemId: string): Promise<void> {
    if (await interestsRepo.deleteUnlessSelected(db.sql, itemId, ngo.id)) return;
    if (await interestsRepo.exists(db.sql, itemId, ngo.id)) throw new AppError('ALREADY_SELECTED');
    throw new AppError('INTEREST_NOT_FOUND');
  },

  /** Só o doador dono do item vê quem curtiu. */
  async listInterested(donor: AuthUser, itemId: string): Promise<InterestedNgo[]> {
    const item = await itemsRepo.findById(db.sql, itemId);
    if (!item) throw new AppError('ITEM_NOT_FOUND');
    if (item.donor_id !== donor.id) throw new AppError('FORBIDDEN', 'Apenas o doador do item vê as interessadas.');
    return interestsRepo.listByItem(db.sql, itemId);
  },

  /** DISPONIVEL → EM_PROGRESSO. Uma ida ao banco no caminho feliz; leituras extras só para escolher o erro. */
  async selectNgo(donorId: string, itemId: string, ngoId: string): Promise<Item> {
    return db.tx(async (tx) => {
      const item = await itemsRepo.selectNgoIfAvailable(tx, itemId, donorId, ngoId);
      if (item) {
        await eventsRepo.insert(tx, { itemId, from: 'DISPONIVEL', to: 'EM_PROGRESSO', actorId: donorId, ngoId });
        return item;
      }

      const current = await itemsRepo.findById(tx, itemId);
      if (!current) throw new AppError('ITEM_NOT_FOUND');
      if (current.donor_id !== donorId) throw new AppError('FORBIDDEN', 'Apenas o doador do item pode escolher a ONG.');
      if (current.status !== 'DISPONIVEL') throw new AppError('ITEM_NOT_AVAILABLE');
      if (!(await interestsRepo.exists(tx, itemId, ngoId))) throw new AppError('NGO_NOT_INTERESTED');
      throw new AppError('NGO_NOT_ACTIVE');
    });
  },
});

export type InterestsService = ReturnType<typeof createInterestsService>;
