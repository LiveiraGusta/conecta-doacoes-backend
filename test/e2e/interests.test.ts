import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/types';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from '../helpers/app';
import { expectContract } from '../helpers/contract';
import { addInterest, authHeader, createAdmin, createDonor, createItem, createNgo } from '../helpers/factories';

type Who = Pick<User, 'id' | 'role'>;

describe('Módulo 3 — Match Invertido', () => {
  let ctx: TestContext;
  let donor: User;
  let ngo: User;

  beforeAll(async () => {
    ctx = await buildTestApp();
  });
  afterAll(() => closeTestApp(ctx));
  beforeEach(async () => {
    await resetDb(ctx.db);
    donor = await createDonor(ctx.db);
    ngo = await createNgo(ctx.db, { name: 'ONG Salvadora' });
  });

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, user: Who, payload?: object) =>
    ctx.app.inject({ method, url: `/api/v1${url}`, headers: authHeader(ctx.app, user), payload });

  describe('POST /items/:id/interest', () => {
    it('201 e o item passa a contar a curtida', async () => {
      const item = await createItem(ctx.db, donor);
      const res = await call('POST', `/items/${item.id}/interest`, ngo);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ item_id: item.id, ngo_id: ngo.id });
      await expectContract(res, 'POST', '/items/{itemId}/interest');

      const feed = (await call('GET', '/items/feed', ngo)).json();
      expect(feed.data[0]).toMatchObject({ has_user_interest: true, interests_count: 1 });
    });

    it('409 ALREADY_INTERESTED na segunda curtida', async () => {
      const item = await createItem(ctx.db, donor);
      await call('POST', `/items/${item.id}/interest`, ngo);
      const res = await call('POST', `/items/${item.id}/interest`, ngo);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('ALREADY_INTERESTED');
      await expectContract(res, 'POST', '/items/{itemId}/interest');
    });

    it('403 OUT_OF_REGION para item de outra cidade (mesmo sabendo o id)', async () => {
      const item = await createItem(ctx.db, donor, { city: 'Campinas' });
      const res = await call('POST', `/items/${item.id}/interest`, ngo);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('OUT_OF_REGION');
      await expectContract(res, 'POST', '/items/{itemId}/interest');
    });

    it('409 ITEM_NOT_AVAILABLE para item em negociação; 404 para item inexistente', async () => {
      const item = await createItem(ctx.db, donor, { status: 'EM_PROGRESSO' });
      const busy = await call('POST', `/items/${item.id}/interest`, ngo);
      expect(busy.statusCode).toBe(409);
      expect(busy.json().error).toBe('ITEM_NOT_AVAILABLE');

      const missing = await call('POST', `/items/${randomUUID()}/interest`, ngo);
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toBe('ITEM_NOT_FOUND');
      await expectContract(missing, 'POST', '/items/{itemId}/interest');
    });

    it('403 NGO_NOT_APPROVED para ONG pendente e rejeitada; 403 FORBIDDEN para doador e admin', async () => {
      const item = await createItem(ctx.db, donor);
      for (const status of ['PENDENTE_APROVACAO', 'REJEITADO'] as const) {
        const res = await call('POST', `/items/${item.id}/interest`, await createNgo(ctx.db, { status }));
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe('NGO_NOT_APPROVED');
        await expectContract(res, 'POST', '/items/{itemId}/interest');
      }
      for (const user of [donor, await createAdmin(ctx.db)]) {
        expect((await call('POST', `/items/${item.id}/interest`, user)).json().error).toBe('FORBIDDEN');
      }
    });
  });

  describe('DELETE /items/:id/interest', () => {
    it('204 desfaz a curtida', async () => {
      const item = await createItem(ctx.db, donor);
      await addInterest(ctx.db, item.id, ngo.id);
      const res = await call('DELETE', `/items/${item.id}/interest`, ngo);
      expect(res.statusCode).toBe(204);
      await expectContract(res, 'DELETE', '/items/{itemId}/interest');
      expect((await call('GET', '/items/feed', ngo)).json().data[0].interests_count).toBe(0);
    });

    it('404 INTEREST_NOT_FOUND sem curtida; 409 ALREADY_SELECTED para a ONG escolhida', async () => {
      const item = await createItem(ctx.db, donor);
      const none = await call('DELETE', `/items/${item.id}/interest`, ngo);
      expect(none.statusCode).toBe(404);
      expect(none.json().error).toBe('INTEREST_NOT_FOUND');
      await expectContract(none, 'DELETE', '/items/{itemId}/interest');

      await addInterest(ctx.db, item.id, ngo.id);
      await call('POST', `/items/${item.id}/select-ngo`, donor, { ngo_id: ngo.id });
      const selected = await call('DELETE', `/items/${item.id}/interest`, ngo);
      expect(selected.statusCode).toBe(409);
      expect(selected.json().error).toBe('ALREADY_SELECTED');
      await expectContract(selected, 'DELETE', '/items/{itemId}/interest');
    });
  });

  describe('GET /items/:id/interests', () => {
    it('lista ATIVO primeiro e depois por data da curtida', async () => {
      const item = await createItem(ctx.db, donor);
      const rejeitada = await createNgo(ctx.db, { status: 'REJEITADO', rejection_reason: 'Motivo qualquer' });
      const segunda = await createNgo(ctx.db);
      await ctx.db.sql`
        INSERT INTO item_interests (item_id, ngo_id, created_at) VALUES
          (${item.id}, ${rejeitada.id}, '2026-11-01T10:00:00Z'),
          (${item.id}, ${segunda.id}, '2026-11-03T10:00:00Z'),
          (${item.id}, ${ngo.id}, '2026-11-02T10:00:00Z')`;

      const res = await call('GET', `/items/${item.id}/interests`, donor);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(3);
      expect(body.interested_ngos.map((n: { ngo_id: string }) => n.ngo_id)).toEqual([ngo.id, segunda.id, rejeitada.id]);
      expect(body.interested_ngos[0]).toMatchObject({ name: 'ONG Salvadora', ngo_status: 'ATIVO' });
      expect(body.interested_ngos[0].cnpj).toMatch(/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/);
      await expectContract(res, 'GET', '/items/{itemId}/interests');
    });

    it('403 para outro doador e para ONG; 404 para item inexistente', async () => {
      const item = await createItem(ctx.db, donor);
      for (const user of [await createDonor(ctx.db), ngo]) {
        const res = await call('GET', `/items/${item.id}/interests`, user);
        expect(res.statusCode).toBe(403);
        await expectContract(res, 'GET', '/items/{itemId}/interests');
      }
      expect((await call('GET', `/items/${randomUUID()}/interests`, donor)).statusCode).toBe(404);
    });
  });

  describe('POST /items/:id/select-ngo', () => {
    it('200: item vai para EM_PROGRESSO, evento gravado, feed mostra a negociação', async () => {
      const item = await createItem(ctx.db, donor);
      await addInterest(ctx.db, item.id, ngo.id);

      const res = await call('POST', `/items/${item.id}/select-ngo`, donor, { ngo_id: ngo.id });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        item_id: item.id,
        status: 'EM_PROGRESSO',
        selected_ngo_id: ngo.id,
        chat_room_url: `/chats/${item.id}`,
      });
      await expectContract(res, 'POST', '/items/{itemId}/select-ngo');

      const events = await ctx.db.sql`SELECT from_status, to_status, actor_id, ngo_id FROM item_events WHERE item_id = ${item.id}`;
      expect(events).toEqual([{ from_status: 'DISPONIVEL', to_status: 'EM_PROGRESSO', actor_id: donor.id, ngo_id: ngo.id }]);
      expect((await call('GET', '/items/feed', ngo)).json().data[0]).toMatchObject({ status: 'EM_PROGRESSO', is_selected: true });
    });

    it('cada código de erro do contrato', async () => {
      const item = await createItem(ctx.db, donor);
      const semCurtida = await createNgo(ctx.db);
      const rejeitada = await createNgo(ctx.db);
      await addInterest(ctx.db, item.id, rejeitada.id);
      await ctx.db.sql`UPDATE ngo_profiles SET status = 'REJEITADO', rejection_reason = 'Motivo qualquer' WHERE user_id = ${rejeitada.id}`;

      const cases: [Who, string, unknown, number, string][] = [
        [donor, item.id, semCurtida.id, 409, 'NGO_NOT_INTERESTED'],
        [donor, item.id, rejeitada.id, 409, 'NGO_NOT_ACTIVE'],
        [await createDonor(ctx.db), item.id, rejeitada.id, 403, 'FORBIDDEN'],
        [donor, randomUUID(), ngo.id, 404, 'ITEM_NOT_FOUND'],
        [donor, item.id, 'nao-e-uuid', 400, 'VALIDATION_ERROR'],
        [ngo, item.id, ngo.id, 403, 'FORBIDDEN'],
      ];
      for (const [user, itemId, ngoId, status, error] of cases) {
        const res = await call('POST', `/items/${itemId}/select-ngo`, user, { ngo_id: ngoId });
        expect(res.statusCode, error).toBe(status);
        expect(res.json().error).toBe(error);
        await expectContract(res, 'POST', '/items/{itemId}/select-ngo');
      }

      await addInterest(ctx.db, item.id, ngo.id);
      await call('POST', `/items/${item.id}/select-ngo`, donor, { ngo_id: ngo.id });
      const again = await call('POST', `/items/${item.id}/select-ngo`, donor, { ngo_id: ngo.id });
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe('ITEM_NOT_AVAILABLE');
    });

    it('duas escolhas simultâneas pela rota: uma 200, outra 409', async () => {
      const item = await createItem(ctx.db, donor);
      const outra = await createNgo(ctx.db);
      await addInterest(ctx.db, item.id, ngo.id);
      await addInterest(ctx.db, item.id, outra.id);

      const results = await Promise.all([
        call('POST', `/items/${item.id}/select-ngo`, donor, { ngo_id: ngo.id }),
        call('POST', `/items/${item.id}/select-ngo`, donor, { ngo_id: outra.id }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const [events] = await ctx.db.sql`SELECT count(*)::int AS n FROM item_events WHERE item_id = ${item.id}`;
      expect(events!.n).toBe(1);
    });
  });
});
