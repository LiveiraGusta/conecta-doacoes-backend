import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/core/db';
import { itemsRepository } from '../../src/modules/items/items.repository';
import { resetDb } from '../helpers/app';
import { createDonor, createItem, createNgo } from '../helpers/factories';

describe('transições EM_PROGRESSO → DOADO / DISPONIVEL (Postgres real)', () => {
  let db: Db;
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL);
  });
  afterAll(() => db.close());
  beforeEach(() => resetDb(db));

  it('confirmar e cancelar ao mesmo tempo: só uma transição vence', async () => {
    const donor = await createDonor(db);
    const ngo = await createNgo(db);

    for (let round = 0; round < 10; round++) {
      const item = await createItem(db, donor, { status: 'EM_PROGRESSO', selected_ngo_id: ngo.id });
      const [confirmed, cancelled] = await Promise.all([
        db.tx((tx) => itemsRepository.confirmIfInProgress(tx, item.id, ngo.id)),
        db.tx((tx) => itemsRepository.cancelIfInProgress(tx, item.id, donor.id)),
      ]);
      expect([confirmed, cancelled].filter(Boolean)).toHaveLength(1);

      const [row] = await db.sql<{ status: string; selected_ngo_id: string | null }[]>`
        SELECT status, selected_ngo_id FROM items WHERE id = ${item.id}`;
      expect(row).toEqual(
        confirmed ? { status: 'DOADO', selected_ngo_id: ngo.id } : { status: 'DISPONIVEL', selected_ngo_id: null },
      );
      if (cancelled) expect(cancelled.previous_ngo_id).toBe(ngo.id);
    }
  });

  it('DOADO é final: nem cancelar nem confirmar de novo mudam o item', async () => {
    const donor = await createDonor(db);
    const ngo = await createNgo(db);
    const item = await createItem(db, donor, { status: 'DOADO', selected_ngo_id: ngo.id });
    expect(await db.tx((tx) => itemsRepository.cancelIfInProgress(tx, item.id, donor.id))).toBeNull();
    expect(await db.tx((tx) => itemsRepository.confirmIfInProgress(tx, item.id, ngo.id))).toBeNull();
  });
});
