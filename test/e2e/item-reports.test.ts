import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/types';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from '../helpers/app';
import { expectContract } from '../helpers/contract';
import { addInterest, authHeader, createAdmin, createDonor, createItem, createNgo } from '../helpers/factories';

type Who = Pick<User, 'id' | 'role'>;

describe('Denúncia de anúncio e moderação de itens', () => {
  let ctx: TestContext;
  let donor: User;
  let ngo: User;
  let admin: User;

  beforeAll(async () => {
    ctx = await buildTestApp();
  });
  afterAll(() => closeTestApp(ctx));
  beforeEach(async () => {
    await resetDb(ctx.db);
    donor = await createDonor(ctx.db, { name: 'Marina Souza' });
    ngo = await createNgo(ctx.db, { name: 'ONG Abrigo' });
    admin = await createAdmin(ctx.db);
  });

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, who?: Who, payload?: object) =>
    ctx.app.inject({ method, url: `/api/v1${url}`, headers: who ? authHeader(ctx.app, who) : {}, payload });
  const reportItem = (itemId: string, who: Who, body: object = { category: 'NUDEZ' }) =>
    call('POST', `/items/${itemId}/report`, who, body);
  const moderation = async (itemId: string) =>
    (await ctx.db.sql<{ moderation_status: string }[]>`SELECT moderation_status FROM items WHERE id = ${itemId}`)[0]!
      .moderation_status;
  /** Três pessoas diferentes (além do doador) denunciando o anúncio. */
  const threeReports = async (itemId: string) => {
    const others = [ngo, await createDonor(ctx.db), await createNgo(ctx.db, { status: 'PENDENTE_APROVACAO' })];
    for (const who of others) expect((await reportItem(itemId, who)).statusCode).toBe(201);
  };

  describe('POST /items/:itemId/report', () => {
    it('ONG ou doador denuncia; a denunciada é o doador; segunda aberta é 409 ITEM_ALREADY_REPORTED', async () => {
      const item = await createItem(ctx.db, donor);
      const other = await createDonor(ctx.db);

      const res = await reportItem(item.id, ngo, { category: 'ODIO', reason: 'Texto ofensivo na descrição.' });
      expect(res.statusCode).toBe(201);
      await expectContract(res, 'POST', '/items/{itemId}/report');
      expect(res.json()).toMatchObject({
        item_id: item.id,
        reporter_id: ngo.id,
        reported_id: donor.id,
        kind: 'ITEM',
        category: 'ODIO',
        reason: 'Texto ofensivo na descrição.',
        status: 'ABERTA',
        resolution: null,
      });
      expect((await reportItem(item.id, other)).json()).toMatchObject({ reporter_id: other.id, reason: null });

      const again = await reportItem(item.id, ngo);
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe('ITEM_ALREADY_REPORTED');
      await expectContract(again, 'POST', '/items/{itemId}/report');
    });

    it('denúncia de anúncio não conflita com a de negociação do mesmo usuário', async () => {
      const item = await createItem(ctx.db, donor, { status: 'EM_PROGRESSO', selected_ngo_id: ngo.id });
      expect((await call('POST', `/chats/${item.id}/report`, ngo, { reason: 'Pediu dinheiro para entregar.' })).statusCode).toBe(201);
      expect((await reportItem(item.id, ngo)).statusCode).toBe(201);
    });

    it('validação: categoria obrigatória e válida; OUTRO exige descrição', async () => {
      const item = await createItem(ctx.db, donor);
      for (const body of [{}, { category: 'FEIO' }, { category: 'OUTRO' }, { category: 'OUTRO', reason: 'curto' }]) {
        const res = await reportItem(item.id, ngo, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json().error).toBe('VALIDATION_ERROR');
      }
      expect((await reportItem(item.id, ngo, { category: 'OUTRO', reason: 'Item parece roubado.' })).statusCode).toBe(201);
    });

    it('404 inexistente, 403 o próprio doador e o Admin, 401 visitante', async () => {
      const item = await createItem(ctx.db, donor);
      const cases: [string, Who | undefined, number, string][] = [
        ['00000000-0000-4000-8000-000000000000', ngo, 404, 'ITEM_NOT_FOUND'],
        [item.id, donor, 403, 'FORBIDDEN'],
        [item.id, admin, 403, 'FORBIDDEN'],
        [item.id, undefined, 401, 'UNAUTHORIZED'],
      ];
      for (const [itemId, who, status, error] of cases) {
        const res = await call('POST', `/items/${itemId}/report`, who, { category: 'SPAM' });
        expect(res.statusCode, error).toBe(status);
        expect(res.json().error).toBe(error);
        await expectContract(res, 'POST', '/items/{itemId}/report');
      }
    });
  });

  describe('Ocultação automática com 3 pessoas', () => {
    it('com 2 continua no ar; com 3 sai do feed, das rotas públicas e do detalhe de quem está de fora', async () => {
      const item = await createItem(ctx.db, donor);
      const viewer = await createDonor(ctx.db);
      await reportItem(item.id, ngo);
      await reportItem(item.id, await createDonor(ctx.db));
      expect(await moderation(item.id)).toBe('VISIVEL');

      await reportItem(item.id, await createDonor(ctx.db));
      expect(await moderation(item.id)).toBe('OCULTO');

      expect((await call('GET', '/items/feed', viewer)).json().total).toBe(0);
      expect((await call('GET', '/public/items')).json().total).toBe(0);
      expect((await call('GET', `/public/items/${item.id}`)).statusCode).toBe(404);
      expect((await call('GET', `/items/${item.id}`, viewer)).statusCode).toBe(404);
      // Quem chega depois também não denuncia o que não vê.
      expect((await reportItem(item.id, viewer)).statusCode).toBe(404);

      // O doador ainda vê, com o status da moderação (sem motivo: foi automático).
      const own = await call('GET', `/items/${item.id}`, donor);
      expect(own.statusCode).toBe(200);
      await expectContract(own, 'GET', '/items/{itemId}');
      expect(own.json()).toMatchObject({ moderation_status: 'OCULTO', moderation_reason: null });
      const mine = await call('GET', '/items/me', donor);
      await expectContract(mine, 'GET', '/items/me');
      expect(mine.json().data[0]).toMatchObject({ id: item.id, moderation_status: 'OCULTO' });
    });

    it('anúncio oculto: ONG não curte (404) e o doador não escolhe ONG (409 ITEM_UNDER_REVIEW)', async () => {
      const item = await createItem(ctx.db, donor);
      await addInterest(ctx.db, item.id, ngo.id);
      const other = await createNgo(ctx.db);
      await threeReports(item.id);

      const like = await call('POST', `/items/${item.id}/interest`, other);
      expect(like.statusCode).toBe(404);
      const select = await call('POST', `/items/${item.id}/select-ngo`, donor, { ngo_id: ngo.id });
      expect(select.statusCode).toBe(409);
      expect(select.json().error).toBe('ITEM_UNDER_REVIEW');
      await expectContract(select, 'POST', '/items/{itemId}/select-ngo');
    });

    it('denúncias simultâneas de 3 pessoas ocultam o anúncio', async () => {
      const item = await createItem(ctx.db, donor);
      const people = [ngo, await createDonor(ctx.db), await createDonor(ctx.db)];
      const codes = await Promise.all(people.map((p) => reportItem(item.id, p).then((r) => r.statusCode)));
      expect(codes).toEqual([201, 201, 201]);
      expect(await moderation(item.id)).toBe('OCULTO');
    });
  });

  describe('Admin', () => {
    it('fila filtra por tipo e mostra categoria e moderação; PATCH de denúncia de anúncio aberta é 409', async () => {
      const item = await createItem(ctx.db, donor, { status: 'EM_PROGRESSO', selected_ngo_id: ngo.id, title: 'Casaco' });
      await call('POST', `/chats/${item.id}/report`, ngo, { reason: 'Pediu dinheiro para entregar.' });
      const created = (await reportItem(item.id, await createDonor(ctx.db), { category: 'GOLPE' })).json();

      const all = await call('GET', '/admin/reports', admin);
      await expectContract(all, 'GET', '/admin/reports');
      expect(all.json().total).toBe(2);

      const onlyItem = await call('GET', '/admin/reports?kind=ITEM', admin);
      expect(onlyItem.json().total).toBe(1);
      expect(onlyItem.json().data[0]).toMatchObject({
        id: created.id,
        kind: 'ITEM',
        category: 'GOLPE',
        item: { id: item.id, title: 'Casaco', moderation_status: 'VISIVEL' },
        reported: { id: donor.id, role: 'DONOR' },
      });

      const patch = await call('PATCH', `/admin/reports/${created.id}`, admin, { status: 'RESOLVIDA' });
      expect(patch.statusCode).toBe(409);
      expect(patch.json().error).toBe('CONFLICT');
      await expectContract(patch, 'PATCH', '/admin/reports/{reportId}');
    });

    it('detalhe de denúncia de anúncio: fotos, todas as denúncias do item e sem a conversa', async () => {
      const item = await createItem(ctx.db, donor, { status: 'EM_PROGRESSO', selected_ngo_id: ngo.id });
      await call('POST', `/chats/${item.id}/messages`, ngo, { message: 'Conversa privada' });
      const first = (await reportItem(item.id, await createDonor(ctx.db), { category: 'NUDEZ' })).json();
      await reportItem(item.id, ngo, { category: 'VIOLENCIA', reason: 'Imagem com sangue.' });

      const res = await call('GET', `/admin/reports/${first.id}`, admin);
      expect(res.statusCode).toBe(200);
      await expectContract(res, 'GET', '/admin/reports/{reportId}');
      const body = res.json();
      expect(body.report).toMatchObject({ kind: 'ITEM', category: 'NUDEZ', reason: null });
      expect(body.item.photos).toHaveLength(3);
      expect(body.item).toMatchObject({ description: 'Em bom estado', moderation_status: 'VISIVEL' });
      expect(body.item_reports.map((r: { category: string }) => r.category)).toEqual(['NUDEZ', 'VIOLENCIA']);
      expect(body.messages).toEqual([]);
    });

    it('remover item em negociação: cancela, resolve as denúncias, some do feed e o doador vê o motivo', async () => {
      const item = await createItem(ctx.db, donor, { status: 'EM_PROGRESSO', selected_ngo_id: ngo.id });
      await addInterest(ctx.db, item.id, ngo.id);
      await threeReports(item.id);

      const res = await call('POST', `/admin/items/${item.id}/remove`, admin, { reason: 'Foto com nudez explícita.' });
      expect(res.statusCode).toBe(200);
      await expectContract(res, 'POST', '/admin/items/{itemId}/remove');
      expect(res.json()).toEqual({
        item_id: item.id,
        status: 'DISPONIVEL',
        moderation_status: 'REMOVIDO',
        moderation_reason: 'Foto com nudez explícita.',
        cancelled_negotiation: true,
        resolved_reports: 3,
      });

      const events = await ctx.db.sql<{ to_status: string; actor_id: string }[]>`
        SELECT to_status, actor_id FROM item_events WHERE item_id = ${item.id} ORDER BY created_at`;
      expect(events.map((e) => e.to_status)).toEqual(['CANCELADO', 'DISPONIVEL']);
      expect(events.every((e) => e.actor_id === admin.id)).toBe(true);

      const resolved = (await call('GET', '/admin/reports?status=RESOLVIDA&kind=ITEM', admin)).json();
      expect(resolved.total).toBe(3);
      expect(resolved.data.every((r: { resolution: string }) => r.resolution === 'ITEM_REMOVIDO')).toBe(true);

      // Chat fechado, item fora das listas da ONG; o doador vê o motivo.
      expect((await call('GET', `/chats/${item.id}/messages`, ngo)).statusCode).toBe(403);
      expect((await call('GET', '/items/me', ngo)).json().total).toBe(0);
      expect((await call('GET', `/items/${item.id}`, ngo)).statusCode).toBe(404);
      const own = (await call('GET', `/items/${item.id}`, donor)).json();
      expect(own).toMatchObject({ moderation_status: 'REMOVIDO', moderation_reason: 'Foto com nudez explícita.' });

      // Removido não recebe denúncias nem escolha de ONG.
      expect((await reportItem(item.id, await createDonor(ctx.db))).statusCode).toBe(404);
      const select = await call('POST', `/items/${item.id}/select-ngo`, donor, { ngo_id: ngo.id });
      expect(select.json().error).toBe('ITEM_REMOVED');

      // Idempotente.
      const again = await call('POST', `/admin/items/${item.id}/remove`, admin, { reason: 'Outro motivo qualquer.' });
      expect(again.json()).toMatchObject({ moderation_reason: 'Foto com nudez explícita.', cancelled_negotiation: false, resolved_reports: 0 });
    });

    it('manter: volta ao feed e descarta as denúncias como IMPROCEDENTE', async () => {
      const item = await createItem(ctx.db, donor);
      await threeReports(item.id);
      expect(await moderation(item.id)).toBe('OCULTO');

      const res = await call('POST', `/admin/items/${item.id}/restore`, admin);
      expect(res.statusCode).toBe(200);
      await expectContract(res, 'POST', '/admin/items/{itemId}/restore');
      expect(res.json()).toMatchObject({ moderation_status: 'VISIVEL', resolved_reports: 3 });
      expect((await call('GET', '/public/items')).json().total).toBe(1);
      const resolved = (await call('GET', '/admin/reports?status=RESOLVIDA', admin)).json();
      expect(resolved.data.every((r: { resolution: string }) => r.resolution === 'IMPROCEDENTE')).toBe(true);

      // Depois de descartadas, as mesmas pessoas podem denunciar de novo.
      expect((await reportItem(item.id, ngo)).statusCode).toBe(201);
    });

    it('ações do Admin: 403 para não-Admin, 404 item inexistente, 400 motivo curto', async () => {
      const item = await createItem(ctx.db, donor);
      const missing = '00000000-0000-4000-8000-000000000000';
      const cases: [string, Who, object | undefined, number][] = [
        [`/admin/items/${item.id}/remove`, donor, { reason: 'Motivo qualquer.' }, 403],
        [`/admin/items/${item.id}/restore`, ngo, undefined, 403],
        [`/admin/items/${missing}/remove`, admin, { reason: 'Motivo qualquer.' }, 404],
        [`/admin/items/${missing}/restore`, admin, undefined, 404],
        [`/admin/items/${item.id}/remove`, admin, { reason: 'curto' }, 400],
      ];
      for (const [url, who, body, status] of cases) {
        const res = await call('POST', url, who, body);
        expect(res.statusCode, url).toBe(status);
        await expectContract(res, 'POST', url.replace(/items\/[^/]+/, 'items/{itemId}'));
      }
    });
  });
});
