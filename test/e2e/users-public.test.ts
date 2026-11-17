import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/types';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from '../helpers/app';
import { expectContract } from '../helpers/contract';
import { addInterest, authHeader, createAdmin, createDonor, createItem, createNgo } from '../helpers/factories';

type Who = Pick<User, 'id' | 'role'>;

describe('Página pessoal e acesso de visitante', () => {
  let ctx: TestContext;
  let donor: User;
  let ngo: User & { ngo_profile_id: string };

  beforeAll(async () => {
    ctx = await buildTestApp();
  });
  afterAll(() => closeTestApp(ctx));
  beforeEach(async () => {
    await resetDb(ctx.db);
    donor = await createDonor(ctx.db, { name: 'Marina Souza' });
    ngo = await createNgo(ctx.db, { name: 'ONG Salvadora' });
    await ctx.db.sql`UPDATE users SET bio = 'Atendemos 200 famílias.', avatar_url = 'https://storage.test/items/profiles/x/avatar.webp' WHERE id = ${ngo.id}`;
    await ctx.db.sql`
      UPDATE ngo_profiles SET phone = '11987654321', instagram = 'ongsalvadora', banner_url = 'https://storage.test/items/profiles/x/banner.webp',
        accepted_categories = ARRAY['ROUPAS', 'LIVROS']::VARCHAR(20)[],
        cep = '01310100', street = 'Av. Paulista', number = '1000', neighborhood = 'Bela Vista'
      WHERE user_id = ${ngo.id}`;
  });

  const get = (url: string, who?: Who) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: who ? authHeader(ctx.app, who) : {} });

  /** Item doado pela doadora e recebido pela ONG. */
  const donated = (title = 'Casaco doado') =>
    createItem(ctx.db, donor, { title, status: 'DOADO', selected_ngo_id: ngo.id });

  describe('GET /users/:userId', () => {
    it('ONG ATIVO: nome completo, banner, categorias, contato e endereço; contagem de recebidas', async () => {
      await donated();
      const res = await get(`/users/${ngo.id}`, donor);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: ngo.id,
        role: 'NGO',
        name: 'ONG Salvadora',
        bio: 'Atendemos 200 famílias.',
        avatar_url: expect.stringContaining('avatar.webp'),
        donations_count: 1,
        ngo: {
          status: 'ATIVO',
          banner_url: expect.stringContaining('banner.webp'),
          accepted_categories: ['ROUPAS', 'LIVROS'],
          phone: '11987654321',
          instagram: 'ongsalvadora',
          address: { cep: '01310100', street: 'Av. Paulista', number: '1000', complement: null, neighborhood: 'Bela Vista' },
        },
      });
      await expectContract(res, 'GET', '/users/{userId}');
    });

    it('ONG pendente: sem contato nem endereço para os outros; ela mesma vê os seus', async () => {
      await ctx.db.sql`UPDATE ngo_profiles SET status = 'PENDENTE_APROVACAO' WHERE user_id = ${ngo.id}`;
      const other = (await get(`/users/${ngo.id}`, donor)).json();
      expect(other.ngo).toMatchObject({ status: 'PENDENTE_APROVACAO', phone: null, instagram: null, address: null });
      expect(other.ngo.accepted_categories).toEqual(['ROUPAS', 'LIVROS']);

      const self = (await get(`/users/${ngo.id}`, ngo)).json();
      expect(self.ngo).toMatchObject({ phone: '11987654321', address: { cep: '01310100' } });
    });

    it('doador: nome abreviado, sem bloco de ONG; contagem só se ele mostrar (ou para ele mesmo)', async () => {
      await donated();
      const hidden = await get(`/users/${donor.id}`, ngo);
      expect(hidden.json()).toMatchObject({ role: 'DONOR', name: 'Marina S.', ngo: null, donations_count: null });
      await expectContract(hidden, 'GET', '/users/{userId}');
      expect((await get(`/users/${donor.id}`, donor)).json().donations_count).toBe(1);

      await ctx.db.sql`INSERT INTO user_preferences (user_id, show_donations) VALUES (${donor.id}, TRUE)`;
      expect((await get(`/users/${donor.id}`, ngo)).json().donations_count).toBe(1);
    });

    it('404 USER_NOT_FOUND para Admin, conta excluída e id inexistente; 401 sem sessão', async () => {
      const admin = await createAdmin(ctx.db);
      const gone = await createDonor(ctx.db);
      await ctx.db.sql`UPDATE users SET deleted_at = NOW() WHERE id = ${gone.id}`;
      for (const id of [admin.id, gone.id, randomUUID()]) {
        const res = await get(`/users/${id}`, donor);
        expect(res.statusCode).toBe(404);
        expect(res.json().error).toBe('USER_NOT_FOUND');
        await expectContract(res, 'GET', '/users/{userId}');
      }
      expect((await get(`/users/${ngo.id}`)).statusCode).toBe(401);
    });
  });

  describe('GET /users/:userId/donations', () => {
    it('doador com doações ocultas: lista vazia e hidden, sem revelar se existem', async () => {
      await donated();
      const res = await get(`/users/${donor.id}/donations`, ngo);
      expect(res.json()).toEqual({ total: 0, data: [], hidden: true });
      await expectContract(res, 'GET', '/users/{userId}/donations');
      // O próprio doador sempre vê.
      expect((await get(`/users/${donor.id}/donations`, donor)).json()).toMatchObject({ total: 1, hidden: false });
    });

    it('doador que mostra: só DOADO, com o card do feed; ONG: itens recebidos', async () => {
      await ctx.db.sql`INSERT INTO user_preferences (user_id, show_donations) VALUES (${donor.id}, TRUE)`;
      const item = await donated('Livros doados');
      await createItem(ctx.db, donor, { title: 'Ainda disponível' });

      const ofDonor = (await get(`/users/${donor.id}/donations`, ngo)).json();
      expect(ofDonor).toMatchObject({ total: 1, hidden: false });
      expect(ofDonor.data.map((i: { id: string }) => i.id)).toEqual([item.id]);
      expect(ofDonor.data[0]).toMatchObject({ status: 'DOADO', donor: { name: 'Marina S.' } });

      const ofNgo = await get(`/users/${ngo.id}/donations?limit=5`, donor);
      expect(ofNgo.json()).toMatchObject({ total: 1, hidden: false, data: [{ id: item.id }] });
      await expectContract(ofNgo, 'GET', '/users/{userId}/donations');
    });
  });

  describe('visitante (/public/*)', () => {
    it('feed de todas as cidades, sem DOADO, sem doador, observações nem contagem', async () => {
      const rio = await createDonor(ctx.db, { city: 'Rio de Janeiro', state: 'RJ' });
      const sp = await createItem(ctx.db, donor, { title: 'Casaco SP', notes: 'Retirar à noite' });
      const rj = await createItem(ctx.db, rio, { title: 'Livros RJ' });
      await addInterest(ctx.db, sp.id, ngo.id);
      await donated();

      const res = await get('/public/items');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(2);
      expect(body.data.map((i: { id: string }) => i.id).sort()).toEqual([sp.id, rj.id].sort());
      expect(Object.keys(body.data[0]).sort()).toEqual(
        ['category', 'city', 'created_at', 'description', 'id', 'photos', 'state', 'status', 'title'].sort(),
      );
      expect(body.data[0].photos).toHaveLength(3);
      await expectContract(res, 'GET', '/public/items');

      const filtered = (await get('/public/items?search=livros&limit=1')).json();
      expect(filtered).toMatchObject({ total: 1, data: [{ id: rj.id, city: 'Rio de Janeiro' }] });
    });

    it('detalhe público: item do feed sim; DOADO e inexistente dão 404', async () => {
      const item = await createItem(ctx.db, donor, { notes: 'segredo' });
      const res = await get(`/public/items/${item.id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('notes');
      expect(res.json()).not.toHaveProperty('donor');
      await expectContract(res, 'GET', '/public/items/{itemId}');

      for (const id of [(await donated()).id, randomUUID()]) {
        const r = await get(`/public/items/${id}`);
        expect(r.statusCode).toBe(404);
        expect(r.json().error).toBe('ITEM_NOT_FOUND');
      }
    });

    it('perfil público da ONG ATIVO: só descrição, cidade, categorias e contagem', async () => {
      await donated();
      const res = await get(`/public/users/${ngo.id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id: ngo.id,
        role: 'NGO',
        city: ngo.city,
        state: ngo.state,
        bio: 'Atendemos 200 famílias.',
        accepted_categories: ['ROUPAS', 'LIVROS'],
        donations_count: 1,
      });
      await expectContract(res, 'GET', '/public/users/{userId}');
      const raw = res.body;
      for (const leak of ['ONG Salvadora', 'avatar', 'banner', '11987654321', 'ongsalvadora', 'Paulista', ngo.email]) {
        expect(raw, leak).not.toContain(leak);
      }
    });

    it('perfil público: doador sem nome; ONG não ATIVO, Admin e excluído dão 404', async () => {
      const res = await get(`/public/users/${donor.id}`);
      expect(res.json()).toEqual({
        id: donor.id,
        role: 'DONOR',
        city: donor.city,
        state: donor.state,
        bio: null,
        accepted_categories: [],
        donations_count: null,
      });
      expect(res.body).not.toContain('Marina');

      await ctx.db.sql`UPDATE ngo_profiles SET status = 'REJEITADO' WHERE user_id = ${ngo.id}`;
      const admin = await createAdmin(ctx.db);
      for (const id of [ngo.id, admin.id, randomUUID()]) {
        const r = await get(`/public/users/${id}`);
        expect(r.statusCode).toBe(404);
        expect(r.json().error).toBe('USER_NOT_FOUND');
      }
    });
  });

  describe('avatar fora da página pessoal', () => {
    it('vem no doador do feed/detalhe, nas interessadas e na contraparte do chat', async () => {
      await ctx.db.sql`UPDATE users SET avatar_url = 'https://storage.test/items/profiles/d/avatar.webp' WHERE id = ${donor.id}`;
      const item = await createItem(ctx.db, donor);
      await addInterest(ctx.db, item.id, ngo.id);

      const feed = (await get('/items/feed', ngo)).json();
      expect(feed.data[0].donor.avatar_url).toContain('/d/avatar.webp');
      expect((await get(`/items/${item.id}`, ngo)).json().donor.avatar_url).toContain('/d/avatar.webp');

      const interests = await get(`/items/${item.id}/interests`, donor);
      expect(interests.json().interested_ngos[0].avatar_url).toContain('/x/avatar.webp');
      await expectContract(interests, 'GET', '/items/{itemId}/interests');

      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/items/${item.id}/select-ngo`,
        headers: authHeader(ctx.app, donor),
        payload: { ngo_id: ngo.id },
      });
      const chats = await get('/chats', ngo);
      expect(chats.json().data[0].counterpart.avatar_url).toContain('/d/avatar.webp');
      await expectContract(chats, 'GET', '/chats');
      const room = await get(`/chats/${item.id}/messages`, donor);
      expect(room.json().counterpart.avatar_url).toContain('/x/avatar.webp');
      await expectContract(room, 'GET', '/chats/{itemId}/messages');
    });
  });
});
