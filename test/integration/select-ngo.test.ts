import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/core/db';
import { itemsRepository } from '../../src/modules/items/items.repository';
import { resetDb } from '../helpers/app';
import { addInterest, createDonor, createItem, createNgo } from '../helpers/factories';

describe('itemsRepository.selectNgoIfAvailable (Postgres real)', () => {
  let db: Db;
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL);
  });
  afterAll(() => db.close());
  beforeEach(() => resetDb(db));

  it('só uma de duas escolhas simultâneas vence', async () => {
    const donor = await createDonor(db);
    const [ngoA, ngoB] = [await createNgo(db), await createNgo(db)];

    // Repete para dar chance real de as duas transações se cruzarem.
    for (let round = 0; round < 10; round++) {
      const item = await createItem(db, donor);
      await addInterest(db, item.id, ngoA.id);
      await addInterest(db, item.id, ngoB.id);

      const [a, b] = await Promise.all([
        db.tx((tx) => itemsRepository.selectNgoIfAvailable(tx, item.id, donor.id, ngoA.id)),
        db.tx((tx) => itemsRepository.selectNgoIfAvailable(tx, item.id, donor.id, ngoB.id)),
      ]);
      const winners = [a, b].filter(Boolean);
      expect(winners).toHaveLength(1);

      const [row] = await db.sql<{ status: string; selected_ngo_id: string }[]>`
        SELECT status, selected_ngo_id FROM items WHERE id = ${item.id}`;
      expect(row).toEqual({ status: 'EM_PROGRESSO', selected_ngo_id: winners[0]!.selected_ngo_id });
    }
  });

  it('recusa ONG sem curtida, ONG não ativa e doador que não é o dono', async () => {
    const donor = await createDonor(db);
    const item = await createItem(db, donor);
    const semCurtida = await createNgo(db);
    const pendente = await createNgo(db, { status: 'PENDENTE_APROVACAO' });
    await addInterest(db, item.id, pendente.id);
    const outroDoador = await createDonor(db);

    expect(await itemsRepository.selectNgoIfAvailable(db.sql, item.id, donor.id, semCurtida.id)).toBeNull();
    expect(await itemsRepository.selectNgoIfAvailable(db.sql, item.id, donor.id, pendente.id)).toBeNull();
    expect(await itemsRepository.selectNgoIfAvailable(db.sql, item.id, outroDoador.id, pendente.id)).toBeNull();
    const [row] = await db.sql`SELECT status FROM items WHERE id = ${item.id}`;
    expect(row!.status).toBe('DISPONIVEL');
  });
});
