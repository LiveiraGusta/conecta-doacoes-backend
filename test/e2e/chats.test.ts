import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/types';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from '../helpers/app';
import { expectContract } from '../helpers/contract';
import { addInterest, authHeader, createAdmin, createDonor, createItem, createNgo, imageBuffer } from '../helpers/factories';
import { multipart } from '../helpers/multipart';

type Who = Pick<User, 'id' | 'role'>;

describe('Módulo 4 — Chat & Encerramento', () => {
  let ctx: TestContext;
  let donor: User;
  let ngo: User;

  beforeAll(async () => {
    ctx = await buildTestApp();
  });
  afterAll(() => closeTestApp(ctx));
  beforeEach(async () => {
    await resetDb(ctx.db);
    ctx.storage.files.clear();
    donor = await createDonor(ctx.db, { name: 'Marina Souza' });
    ngo = await createNgo(ctx.db, { name: 'ONG Salvadora' });
  });

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, user: Who, payload?: object) =>
    ctx.app.inject({ method, url: `/api/v1${url}`, headers: authHeader(ctx.app, user), payload });

  /** Item já em negociação entre `donor` e a ONG dada. */
  async function negotiating(withNgo: User = ngo) {
    const item = await createItem(ctx.db, donor);
    await addInterest(ctx.db, item.id, withNgo.id);
    const res = await call('POST', `/items/${item.id}/select-ngo`, donor, { ngo_id: withNgo.id });
    expect(res.statusCode).toBe(200);
    return item;
  }

  it('ciclo completo: publicar → curtir → escolher → mensagem → confirmar', async () => {
    const jpg = await imageBuffer('jpeg', 64);
    const body = multipart(
      { title: 'Bicicleta aro 20', category: 'BRINQUEDOS' },
      [0, 1, 2].map((i) => ({ field: 'photos', filename: `f${i}.jpg`, content: jpg })),
    );
    const pub = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      payload: body.payload,
      headers: { ...body.headers, ...authHeader(ctx.app, donor) },
    });
    expect(pub.statusCode).toBe(201);
    const itemId = pub.json().id;

    expect((await call('POST', `/items/${itemId}/interest`, ngo)).statusCode).toBe(201);
    expect((await call('GET', `/items/${itemId}/interests`, donor)).json().total).toBe(1);
    expect((await call('POST', `/items/${itemId}/select-ngo`, donor, { ngo_id: ngo.id })).statusCode).toBe(200);

    const sent = await call('POST', `/chats/${itemId}/messages`, donor, { message: '  Pode buscar sábado?  ' });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ sender_id: donor.id, receiver_id: ngo.id, message: 'Pode buscar sábado?' });
    await expectContract(sent, 'POST', '/chats/{itemId}/messages');
    await call('POST', `/chats/${itemId}/messages`, ngo, { message: 'Posso sim, às 10h.' });

    const room = await call('GET', `/chats/${itemId}/messages`, ngo);
    expect(room.statusCode).toBe(200);
    expect(room.json()).toMatchObject({
      item: { id: itemId, status: 'EM_PROGRESSO', donor_id: donor.id, selected_ngo_id: ngo.id },
      counterpart: { id: donor.id, name: 'Marina Souza', role: 'DONOR' },
    });
    expect(room.json().messages.map((m: { message: string }) => m.message)).toEqual(['Pode buscar sábado?', 'Posso sim, às 10h.']);
    await expectContract(room, 'GET', '/chats/{itemId}/messages');

    const list = await call('GET', '/chats', donor);
    expect(list.json().data[0]).toMatchObject({
      item_id: itemId,
      item_status: 'EM_PROGRESSO',
      counterpart: { id: ngo.id, role: 'NGO' },
      last_message: { message: 'Posso sim, às 10h.', sender_id: ngo.id },
    });
    await expectContract(list, 'GET', '/chats');

    const done = await call('POST', `/items/${itemId}/confirm-receipt`, ngo);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ item_id: itemId, status: 'DOADO' });
    await expectContract(done, 'POST', '/items/{itemId}/confirm-receipt');

    // DOADO: some do feed, histórico continua legível, envio bloqueado.
    expect((await call('GET', '/items/feed', ngo)).json().total).toBe(0);
    expect((await call('GET', `/chats/${itemId}/messages`, donor)).statusCode).toBe(200);
    const closed = await call('POST', `/chats/${itemId}/messages`, donor, { message: 'Obrigada!' });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error).toBe('CHAT_CLOSED');
    expect((await call('GET', '/items/me?status=DOADO', donor)).json().total).toBe(1);

    const events = await ctx.db.sql`SELECT from_status, to_status FROM item_events WHERE item_id = ${itemId} ORDER BY created_at`;
    expect(events.map((e) => `${e.from_status ?? '∅'}→${e.to_status}`)).toEqual([
      '∅→DISPONIVEL',
      'DISPONIVEL→EM_PROGRESSO',
      'EM_PROGRESSO→DOADO',
    ]);
  });

  describe('GET /chats/:itemId/messages', () => {
    it('?after= traz só as mensagens novas (polling)', async () => {
      const item = await negotiating();
      const first = (await call('POST', `/chats/${item.id}/messages`, donor, { message: 'um' })).json();
      await call('POST', `/chats/${item.id}/messages`, ngo, { message: 'dois' });
      const res = await call('GET', `/chats/${item.id}/messages?after=${encodeURIComponent(first.created_at)}`, donor);
      expect(res.json().messages.map((m: { message: string }) => m.message)).toEqual(['dois']);
      expect((await call('GET', `/chats/${item.id}/messages?after=ontem`, donor)).statusCode).toBe(400);
    });

    it('409 CHAT_CLOSED para o doador com item DISPONIVEL', async () => {
      const item = await createItem(ctx.db, donor);
      const res = await call('GET', `/chats/${item.id}/messages`, donor);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('CHAT_CLOSED');
      await expectContract(res, 'GET', '/chats/{itemId}/messages');
    });
  });

  describe('POST /chats/:itemId/messages', () => {
    it('400 com mensagem vazia depois do trim ou acima de 2000 caracteres', async () => {
      const item = await negotiating();
      for (const message of ['   ', 'x'.repeat(2001)]) {
        const res = await call('POST', `/chats/${item.id}/messages`, donor, { message });
        expect(res.statusCode).toBe(400);
        await expectContract(res, 'POST', '/chats/{itemId}/messages');
      }
    });
  });

  describe('POST /items/:itemId/cancel', () => {
    it.each(['DONOR', 'NGO'] as const)('cancelado pelo %s: volta para DISPONIVEL, limpa a ONG e grava 2 eventos', async (side) => {
      const item = await negotiating();
      const actor = side === 'DONOR' ? donor : ngo;
      const res = await call('POST', `/items/${item.id}/cancel`, actor, { reason: 'Imprevisto na logística' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        item_id: item.id,
        previous_status: 'EM_PROGRESSO',
        current_status: 'DISPONIVEL',
        cancelled_by: side,
        message: 'Negociação cancelada. O item voltou para a vitrine.',
      });
      await expectContract(res, 'POST', '/items/{itemId}/cancel');

      const [row] = await ctx.db.sql`SELECT status, selected_ngo_id FROM items WHERE id = ${item.id}`;
      expect(row).toEqual({ status: 'DISPONIVEL', selected_ngo_id: null });
      const events = await ctx.db.sql`
        SELECT from_status, to_status, actor_id, ngo_id, reason FROM item_events
        WHERE item_id = ${item.id} AND (from_status = 'CANCELADO' OR to_status = 'CANCELADO') ORDER BY created_at`;
      expect(events).toEqual([
        { from_status: 'EM_PROGRESSO', to_status: 'CANCELADO', actor_id: actor.id, ngo_id: ngo.id, reason: 'Imprevisto na logística' },
        { from_status: 'CANCELADO', to_status: 'DISPONIVEL', actor_id: actor.id, ngo_id: ngo.id, reason: 'Imprevisto na logística' },
      ]);
      expect((await call('GET', '/items/feed', ngo)).json().data[0]).toMatchObject({ id: item.id, status: 'DISPONIVEL' });
    });

    it('aceita corpo vazio; 409 ITEM_NOT_IN_PROGRESS se já não está em negociação', async () => {
      const item = await negotiating();
      expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/items/${item.id}/cancel`, headers: authHeader(ctx.app, donor) })).statusCode).toBe(200);
      const again = await call('POST', `/items/${item.id}/cancel`, donor, {});
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe('ITEM_NOT_IN_PROGRESS');
      await expectContract(again, 'POST', '/items/{itemId}/cancel');
    });

    it('ONG rejeitada depois de escolhida ainda cancela, mas não confirma', async () => {
      const item = await negotiating();
      await ctx.db.sql`UPDATE ngo_profiles SET status = 'REJEITADO', rejection_reason = 'Motivo qualquer' WHERE user_id = ${ngo.id}`;
      const confirm = await call('POST', `/items/${item.id}/confirm-receipt`, ngo);
      expect(confirm.statusCode).toBe(403);
      expect(confirm.json().error).toBe('NGO_NOT_APPROVED');
      expect((await call('POST', `/items/${item.id}/cancel`, ngo)).statusCode).toBe(200);
    });
  });

  it('nova ONG escolhida não lê a negociação anterior; a mesma ONG de volta vê o histórico', async () => {
    const outra = await createNgo(ctx.db);
    const item = await negotiating();
    await call('POST', `/chats/${item.id}/messages`, donor, { message: 'conversa com a primeira ONG' });
    await call('POST', `/items/${item.id}/cancel`, donor);

    await addInterest(ctx.db, item.id, outra.id);
    await call('POST', `/items/${item.id}/select-ngo`, donor, { ngo_id: outra.id });
    expect((await call('GET', `/chats/${item.id}/messages`, outra)).json().messages).toEqual([]);
    expect((await call('GET', `/chats/${item.id}/messages`, donor)).json().messages).toEqual([]);
    expect((await call('GET', `/chats/${item.id}/messages`, ngo)).statusCode).toBe(403);
    expect((await call('GET', '/chats', donor)).json().data[0].last_message).toBeNull();

    await call('POST', `/items/${item.id}/cancel`, outra);
    await call('POST', `/items/${item.id}/select-ngo`, donor, { ngo_id: ngo.id });
    expect((await call('GET', `/chats/${item.id}/messages`, ngo)).json().messages).toHaveLength(1);
  });

  it('acesso cruzado: outro doador, ONG não selecionada, ONG pendente e admin não entram', async () => {
    const item = await negotiating();
    const outsiders: [string, Who][] = [
      ['outro doador', await createDonor(ctx.db)],
      ['ONG não selecionada', await createNgo(ctx.db)],
      ['ONG pendente', await createNgo(ctx.db, { status: 'PENDENTE_APROVACAO' })],
      ['admin', await createAdmin(ctx.db)],
    ];
    const routes: ['GET' | 'POST', string, object?][] = [
      ['GET', `/chats/${item.id}/messages`],
      ['POST', `/chats/${item.id}/messages`, { message: 'oi' }],
      ['POST', `/items/${item.id}/confirm-receipt`],
      ['POST', `/items/${item.id}/cancel`, {}],
      ['GET', `/items/${item.id}/interests`],
      ['POST', `/items/${item.id}/select-ngo`, { ngo_id: ngo.id }],
    ];
    for (const [who, user] of outsiders) {
      for (const [method, url, payload] of routes) {
        const res = await call(method, url, user, payload);
        expect([403, 409], `${who}: ${method} ${url} → ${res.statusCode}`).toContain(res.statusCode);
        if (res.statusCode === 409) expect(res.json().error, `${who}: ${method} ${url}`).toBe('ITEM_NOT_AVAILABLE');
      }
      expect((await call('GET', '/chats', user)).json().data ?? []).toEqual([]);
    }
    const [row] = await ctx.db.sql`SELECT status, selected_ngo_id FROM items WHERE id = ${item.id}`;
    expect(row).toEqual({ status: 'EM_PROGRESSO', selected_ngo_id: ngo.id });
    expect((await call('GET', `/chats/${randomUUID()}/messages`, donor)).statusCode).toBe(404);
  });
});
