import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/types';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from '../helpers/app';
import { expectContract } from '../helpers/contract';
import { addInterest, authHeader, createDonor, createItem, createNgo, tokenFor } from '../helpers/factories';
import { openWs, type TestWs } from '../helpers/ws';

type Who = Pick<User, 'id' | 'role'>;

describe('V1.1 — Mensagens não lidas', () => {
  let ctx: TestContext;
  let donor: User;
  let ngo: User;
  let itemId: string;
  const sockets: TestWs[] = [];

  beforeAll(async () => {
    ctx = await buildTestApp();
  });
  afterAll(() => closeTestApp(ctx));
  afterEach(() => {
    sockets.splice(0).forEach((s) => s.close());
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    donor = await createDonor(ctx.db);
    ngo = await createNgo(ctx.db);
    itemId = await negotiation(ngo);
  });

  const call = (method: 'GET' | 'POST', url: string, who: Who, payload?: object) =>
    ctx.app.inject({ method, url: `/api/v1${url}`, headers: authHeader(ctx.app, who), payload });
  const say = (who: Who, message: string, id = itemId) => call('POST', `/chats/${id}/messages`, who, { message });
  const unread = async (who: Who) => (await call('GET', '/chats/unread', who)).json();
  const listUnread = async (who: Who) =>
    Object.fromEntries((await call('GET', '/chats', who)).json().data.map((c: { item_id: string; unread_count: number }) => [c.item_id, c.unread_count]));

  /** Cria um item do doador já em negociação com a ONG. */
  async function negotiation(withNgo: User) {
    const item = await createItem(ctx.db, donor);
    await addInterest(ctx.db, item.id, withNgo.id);
    await call('POST', `/items/${item.id}/select-ngo`, donor, { ngo_id: withNgo.id });
    return item.id;
  }

  it('conta as recebidas por conversa e no total; marcar como lida zera e devolve os totais', async () => {
    const other = await negotiation(ngo);
    await say(donor, 'Oi, pode buscar?');
    await say(donor, 'Estou em casa até as 18h');
    await say(donor, 'Outro item também', other);

    const total = await call('GET', '/chats/unread', ngo);
    expect(total.statusCode).toBe(200);
    await expectContract(total, 'GET', '/chats/unread');
    expect(total.json()).toEqual({ unread_messages: 3, unread_chats: 2 });

    const list = await call('GET', '/chats', ngo);
    await expectContract(list, 'GET', '/chats');
    expect(await listUnread(ngo)).toEqual({ [itemId]: 2, [other]: 1 });
    // quem enviou não tem nada a ler
    expect(await unread(donor)).toEqual({ unread_messages: 0, unread_chats: 0 });

    const read = await call('POST', `/chats/${itemId}/read`, ngo);
    expect(read.statusCode).toBe(200);
    await expectContract(read, 'POST', '/chats/{itemId}/read');
    expect(read.json()).toEqual({ unread_messages: 1, unread_chats: 1 });
    expect(await listUnread(ngo)).toEqual({ [itemId]: 0, [other]: 1 });

    // mensagem nova depois da leitura volta a contar
    await say(donor, 'Confirma?');
    expect((await listUnread(ngo))[itemId]).toBe(1);
  });

  it('responder marca a conversa como lida para quem respondeu', async () => {
    await say(donor, 'Oi');
    await say(donor, 'Tudo bem?');
    await say(ngo, 'Tudo! Busco amanhã.');
    expect(await unread(ngo)).toEqual({ unread_messages: 0, unread_chats: 0 });
    expect(await unread(donor)).toEqual({ unread_messages: 1, unread_chats: 1 });
  });

  it('marcar como lida sem mensagens não falha; item DOADO pode ser marcado', async () => {
    expect((await call('POST', `/chats/${itemId}/read`, ngo)).json()).toEqual({ unread_messages: 0, unread_chats: 0 });
    await say(ngo, 'Recebido, obrigado!');
    await call('POST', `/items/${itemId}/confirm-receipt`, ngo);
    expect(await unread(donor)).toEqual({ unread_messages: 1, unread_chats: 1 });
    expect((await call('POST', `/chats/${itemId}/read`, donor)).json()).toEqual({ unread_messages: 0, unread_chats: 0 });
  });

  it('depois de cancelar, a negociação anterior não conta para ninguém', async () => {
    const ngo2 = await createNgo(ctx.db);
    await addInterest(ctx.db, itemId, ngo2.id);
    await say(ngo, 'Mensagem da primeira ONG');
    await call('POST', `/items/${itemId}/cancel`, donor, {});
    expect(await unread(donor)).toEqual({ unread_messages: 0, unread_chats: 0 });

    await call('POST', `/items/${itemId}/select-ngo`, donor, { ngo_id: ngo2.id });
    // a mensagem antiga da 1ª ONG não aparece como não lida na negociação nova
    expect((await listUnread(donor))[itemId]).toBe(0);
    await say(ngo2, 'Olá, sou a segunda ONG');
    expect((await listUnread(donor))[itemId]).toBe(1);
  });

  it('404, 403 para quem não participa e CHAT_CLOSED com item disponível', async () => {
    const outsider = await createNgo(ctx.db);
    const disponivel = (await createItem(ctx.db, donor)).id;
    const cases: [string, Who, number, string][] = [
      ['00000000-0000-4000-8000-000000000000', donor, 404, 'ITEM_NOT_FOUND'],
      [itemId, outsider, 403, 'FORBIDDEN'],
      [disponivel, donor, 409, 'CHAT_CLOSED'],
    ];
    for (const [id, who, status, error] of cases) {
      const res = await call('POST', `/chats/${id}/read`, who);
      expect(res.statusCode, error).toBe(status);
      expect(res.json().error).toBe(error);
      await expectContract(res, 'POST', '/chats/{itemId}/read');
    }
  });

  describe('WebSocket: unread.updated', () => {
    async function connect(who: Who) {
      const s = await openWs(ctx.app);
      sockets.push(s);
      s.send({ type: 'auth', token: tokenFor(ctx.app, who) });
      await s.next({ type: 'ready' });
      return s;
    }

    it('chega a quem recebeu sem estar inscrito na sala, e sincroniza as abas ao marcar como lida', async () => {
      const [aba1, aba2] = [await connect(ngo), await connect(ngo)];
      await say(donor, 'Oi!');

      for (const aba of [aba1, aba2]) {
        expect(await aba.next({ type: 'unread.updated' })).toEqual({
          type: 'unread.updated',
          item_id: itemId,
          unread_count: 1,
          unread_messages: 1,
          unread_chats: 1,
        });
      }

      await call('POST', `/chats/${itemId}/read`, ngo);
      for (const aba of [aba1, aba2]) {
        expect(await aba.next({ type: 'unread.updated' })).toMatchObject({ item_id: itemId, unread_count: 0, unread_messages: 0 });
      }
    });

    it('não vaza para outros usuários', async () => {
      const outsider = await connect(await createNgo(ctx.db));
      await say(donor, 'Oi!');
      await expect(outsider.next({ type: 'unread.updated' }, 300)).rejects.toThrow(/timeout/);
    });
  });
});
