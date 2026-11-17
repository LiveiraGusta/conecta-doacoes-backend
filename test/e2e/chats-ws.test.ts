import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/types';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from '../helpers/app';
import {
  addInterest,
  authHeader,
  createAdmin,
  createDonor,
  createItem,
  createNgo,
  sessionCookie,
  tokenFor,
} from '../helpers/factories';
import { openWs, type TestWs } from '../helpers/ws';

describe('Chat em tempo real (WebSocket /api/v1/chats/ws)', () => {
  let ctx: TestContext;
  let donor: User;
  let ngo: User;
  let itemId: string;
  const open: TestWs[] = [];

  beforeAll(async () => {
    ctx = await buildTestApp();
  });
  afterAll(() => closeTestApp(ctx));
  afterEach(() => {
    open.splice(0).forEach((c) => c.close());
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    donor = await createDonor(ctx.db);
    ngo = await createNgo(ctx.db);
    const item = await createItem(ctx.db, donor);
    await addInterest(ctx.db, item.id, ngo.id);
    await post(`/items/${item.id}/select-ngo`, donor, { ngo_id: ngo.id });
    itemId = item.id;
  });

  function post(url: string, user: Pick<User, 'id' | 'role'>, payload: object = {}) {
    return ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: authHeader(ctx.app, user), payload });
  }

  /** Conecta já com o cookie de sessão (como o navegador) e espera o `ready`. */
  async function connect(user: Pick<User, 'id' | 'role'>) {
    const c = await rawConnect({ cookie: sessionCookie(tokenFor(ctx.app, user)) });
    expect(await c.next({ type: 'ready' })).toEqual({ type: 'ready', user_id: user.id });
    return c;
  }

  async function rawConnect(opts: Parameters<typeof openWs>[1] = {}) {
    const c = await openWs(ctx.app, opts);
    open.push(c);
    return c;
  }

  async function joined(user: Pick<User, 'id' | 'role'>) {
    const c = await connect(user);
    c.send({ type: 'subscribe', item_id: itemId });
    expect(await c.next({ type: 'subscribed' })).toEqual({ type: 'subscribed', item_id: itemId });
    return c;
  }

  it('mensagem enviada pelo REST chega na hora aos dois lados', async () => {
    const [d, n] = await Promise.all([joined(donor), joined(ngo)]);
    const sent = (await post(`/chats/${itemId}/messages`, donor, { message: 'Pode buscar sábado?' })).json();

    for (const c of [d, n]) {
      expect(await c.next({ type: 'message.created' })).toEqual({ type: 'message.created', item_id: itemId, message: sent });
    }
  });

  it('cancelamento avisa os dois lados e fecha a sala', async () => {
    const [d, n] = await Promise.all([joined(donor), joined(ngo)]);
    await post(`/items/${itemId}/cancel`, ngo, { reason: 'Não consigo buscar' });

    for (const c of [d, n]) {
      expect(await c.next({ type: 'item.status_changed' })).toEqual({
        type: 'item.status_changed',
        item_id: itemId,
        previous_status: 'EM_PROGRESSO',
        status: 'DISPONIVEL',
        changed_by: 'NGO',
        reason: 'Não consigo buscar',
        completed_at: null,
      });
      expect(await c.next({ type: 'unsubscribed' })).toEqual({ type: 'unsubscribed', item_id: itemId, reason: 'chat_closed' });
    }

    // A sala fechou: se uma nova negociação abrir, quem ainda estava conectado não recebe nada dela.
    const outra = await createNgo(ctx.db);
    await addInterest(ctx.db, itemId, outra.id);
    await post(`/items/${itemId}/select-ngo`, donor, { ngo_id: outra.id });
    await post(`/chats/${itemId}/messages`, donor, { message: 'conversa nova' });
    await new Promise((r) => setTimeout(r, 100));
    expect(n.inbox.filter((m) => m.type === 'message.created')).toEqual([]);
  });

  it('confirmação avisa com status DOADO e completed_at', async () => {
    const d = await joined(donor);
    const done = (await post(`/items/${itemId}/confirm-receipt`, ngo)).json();
    expect(await d.next({ type: 'item.status_changed' })).toMatchObject({
      status: 'DOADO',
      changed_by: 'NGO',
      completed_at: done.completed_at,
    });
  });

  it('não participante, item inexistente e sala fechada recebem erro na inscrição', async () => {
    const intruso = await connect(await createNgo(ctx.db));
    intruso.send({ type: 'subscribe', item_id: itemId });
    expect(await intruso.next({ type: 'error' })).toMatchObject({ error: 'FORBIDDEN', item_id: itemId });

    const d = await connect(donor);
    d.send({ type: 'subscribe', item_id: '7c3b6f8e-1111-4111-8111-111111111111' });
    expect(await d.next({ type: 'error' })).toMatchObject({ error: 'ITEM_NOT_FOUND' });

    const livre = await createItem(ctx.db, donor);
    d.send({ type: 'subscribe', item_id: livre.id });
    expect(await d.next({ type: 'error' })).toMatchObject({ error: 'CHAT_CLOSED', item_id: livre.id });

    // e o intruso não recebe as mensagens da sala
    await post(`/chats/${itemId}/messages`, donor, { message: 'segredo' });
    await new Promise((r) => setTimeout(r, 100));
    expect(intruso.inbox.some((m) => m.type === 'message.created')).toBe(false);
  });

  it('unsubscribe para de receber; ping responde pong', async () => {
    const d = await joined(donor);
    d.send({ type: 'unsubscribe', item_id: itemId });
    expect(await d.next({ type: 'unsubscribed' })).toEqual({ type: 'unsubscribed', item_id: itemId, reason: 'requested' });
    await post(`/chats/${itemId}/messages`, ngo, { message: 'oi' });
    d.send({ type: 'ping' });
    expect(await d.next({ type: 'pong' })).toEqual({ type: 'pong' });
    expect(d.inbox.some((m) => m.type === 'message.created')).toBe(false);
  });

  it('encerramento do servidor fecha as conexões com 1001 (o cliente reconecta)', async () => {
    const other = await buildTestApp();
    const c = await openWs(other.app, { cookie: sessionCookie(tokenFor(other.app, donor)) });
    await c.next({ type: 'ready' });
    const closing = c.closed();
    await closeTestApp(other);
    expect(await closing).toEqual({ code: 1001, reason: 'Servidor reiniciando' });
  });

  describe('autenticação no handshake (cookie + Origin)', () => {
    it('fecha com 4401 sem cookie de sessão', async () => {
      const c = await rawConnect();
      expect((await c.closed()).code).toBe(4401);
    });

    it('fecha com 4401 com token inválido ou de usuário apagado', async () => {
      const c = await rawConnect({ cookie: sessionCookie('token-invalido') });
      expect((await c.closed()).code).toBe(4401);

      const ghost = await createDonor(ctx.db);
      const token = tokenFor(ctx.app, ghost);
      await ctx.db.sql`DELETE FROM users WHERE id = ${ghost.id}`;
      const c2 = await rawConnect({ cookie: sessionCookie(token) });
      expect((await c2.closed()).code).toBe(4401);
    });

    it('fecha com 4403 para Admin (não participa de chats)', async () => {
      const c = await rawConnect({ cookie: sessionCookie(tokenFor(ctx.app, await createAdmin(ctx.db))) });
      expect((await c.closed()).code).toBe(4403);
    });

    it('fecha com 4403 com Origin de outro site ou sem Origin (cross-site WebSocket hijacking)', async () => {
      const cookie = sessionCookie(tokenFor(ctx.app, donor));
      for (const origin of ['https://site-malicioso.example', null]) {
        const c = await rawConnect({ cookie, origin });
        expect((await c.closed()).code, String(origin)).toBe(4403);
        expect(c.inbox.some((m) => m.type === 'ready'), String(origin)).toBe(false);
      }
    });

    it('mensagem enviada antes do ready espera a autenticação', async () => {
      const c = await rawConnect({ cookie: sessionCookie(tokenFor(ctx.app, donor)) });
      c.send({ type: 'ping' });
      expect(await c.next({ type: 'ready' })).toEqual({ type: 'ready', user_id: donor.id });
      expect(await c.next({ type: 'pong' })).toEqual({ type: 'pong' });
    });

    it('a antiga mensagem {type:"auth"} saiu do protocolo', async () => {
      const c = await connect(donor);
      c.send({ type: 'auth', token: tokenFor(ctx.app, donor) });
      expect(await c.next({ type: 'error' })).toMatchObject({ error: 'VALIDATION_ERROR' });
    });

    it('mensagem fora do protocolo vira erro sem derrubar a conexão', async () => {
      const c = await connect(donor);
      c.ws.send('isto não é json');
      expect(await c.next({ type: 'error' })).toMatchObject({ error: 'VALIDATION_ERROR' });
      c.send({ type: 'subscribe', item_id: 'nao-e-uuid' });
      expect(await c.next({ type: 'error' })).toMatchObject({ error: 'VALIDATION_ERROR' });
      c.send({ type: 'ping' });
      expect(await c.next({ type: 'pong' })).toEqual({ type: 'pong' });
    });
  });
});
