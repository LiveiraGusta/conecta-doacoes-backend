import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/types';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from '../helpers/app';
import { expectContract } from '../helpers/contract';
import {
  addInterest,
  authHeader,
  createAdmin,
  createDonor,
  createItem,
  createNgo,
  PASSWORD,
  pdfBuffer,
} from '../helpers/factories';
import { multipart } from '../helpers/multipart';

type Who = Pick<User, 'id' | 'role'>;

describe('V1.1 — Perfil', () => {
  let ctx: TestContext;
  let donor: User;

  beforeAll(async () => {
    ctx = await buildTestApp();
  });
  afterAll(() => closeTestApp(ctx));
  beforeEach(async () => {
    await resetDb(ctx.db);
    ctx.storage.files.clear();
    donor = await createDonor(ctx.db, { name: 'Marina Souza' });
  });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, auth: Who | string, payload?: object) =>
    ctx.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: typeof auth === 'string' ? { authorization: `Bearer ${auth}` } : authHeader(ctx.app, auth),
      payload,
    });

  const login = async (email: string, password: string) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });

  describe('PATCH /profile', () => {
    it('muda nome e cidade/UF; o feed passa a ser o da nova cidade', async () => {
      const campinas = await createDonor(ctx.db, { city: 'Campinas' });
      await createItem(ctx.db, campinas);

      const res = await call('PATCH', '/profile', donor, { name: 'Marina S. Souza', city: 'Campinas', state: 'SP' });
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ name: 'Marina S. Souza', city: 'Campinas', state: 'SP' });
      await expectContract(res, 'PATCH', '/profile');
      expect((await call('GET', '/items/feed', donor)).json().total).toBe(1);
    });

    it('ONG define e apaga o site', async () => {
      const ngo = await createNgo(ctx.db);
      expect((await call('PATCH', '/profile', ngo, { website: 'https://ong.org.br' })).json().user.ngo_profile.website).toBe(
        'https://ong.org.br',
      );
      expect((await call('PATCH', '/profile', ngo, { website: null })).json().user.ngo_profile.website).toBeNull();
    });

    it.each([
      ['corpo vazio', {}],
      ['cidade sem UF', { city: 'Campinas' }],
      ['site enviado por doador', { website: 'https://x.dev' }],
      ['e-mail não é editável', { email: 'novo@x.dev' }],
    ])('400: %s', async (_caso, payload) => {
      const res = await call('PATCH', '/profile', donor, payload);
      expect(res.statusCode).toBe(400);
      await expectContract(res, 'PATCH', '/profile');
    });

    it('403 para Admin', async () => {
      expect((await call('PATCH', '/profile', await createAdmin(ctx.db), { name: 'Admin' })).statusCode).toBe(403);
    });
  });

  describe('PATCH /profile/password', () => {
    it('troca a senha, derruba tokens antigos e o login novo funciona', async () => {
      const old = (await login(donor.email, PASSWORD)).json().token;
      await new Promise((r) => setTimeout(r, 1100)); // tokens antigos: emitidos num segundo anterior à troca

      const res = await call('PATCH', '/profile/password', old, { current_password: PASSWORD, new_password: 'NovaSenha9' });
      expect(res.statusCode).toBe(204);
      await expectContract(res, 'PATCH', '/profile/password');

      expect((await call('GET', '/auth/me', old)).statusCode).toBe(401);
      expect((await login(donor.email, PASSWORD)).statusCode).toBe(401);
      const fresh = await login(donor.email, 'NovaSenha9');
      expect(fresh.statusCode).toBe(200);
      expect((await call('GET', '/auth/me', fresh.json().token)).statusCode).toBe(200);
    });

    it('400 INVALID_CURRENT_PASSWORD, SAME_PASSWORD e senha nova fora da regra', async () => {
      const cases: [object, string][] = [
        [{ current_password: 'Errada123', new_password: 'NovaSenha9' }, 'INVALID_CURRENT_PASSWORD'],
        [{ current_password: PASSWORD, new_password: PASSWORD }, 'SAME_PASSWORD'],
        [{ current_password: PASSWORD, new_password: 'curta1' }, 'VALIDATION_ERROR'],
      ];
      for (const [payload, error] of cases) {
        const res = await call('PATCH', '/profile/password', donor, payload);
        expect(res.statusCode, error).toBe(400);
        expect(res.json().error).toBe(error);
        await expectContract(res, 'PATCH', '/profile/password');
      }
    });
  });

  describe('PUT /profile/ngo-document', () => {
    const resubmit = (user: Who, content: Buffer) => {
      const body = multipart({}, [{ field: 'document', filename: 'cnpj.pdf', content }]);
      return ctx.app.inject({
        method: 'PUT',
        url: '/api/v1/profile/ngo-document',
        payload: body.payload,
        headers: { ...body.headers, ...authHeader(ctx.app, user) },
      });
    };

    it('ONG rejeitada reenvia: volta para análise, motivo limpo, documento antigo apagado', async () => {
      const ngo = await createNgo(ctx.db, { status: 'REJEITADO', rejection_reason: 'Documento ilegível.' });
      const [profile] = await ctx.db.sql<{ document_url: string }[]>`
        SELECT document_url FROM ngo_profiles WHERE user_id = ${ngo.id}`;
      const oldPath = profile!.document_url;
      await ctx.storage.upload('docs', oldPath, pdfBuffer(), 'application/pdf');

      const res = await resubmit(ngo, pdfBuffer());
      expect(res.statusCode).toBe(200);
      expect(res.json().user.ngo_profile).toMatchObject({ status: 'PENDENTE_APROVACAO', rejection_reason: null });
      await expectContract(res, 'PUT', '/profile/ngo-document');
      expect(ctx.storage.files.has(`docs/${oldPath}`)).toBe(false);
      expect(ctx.storage.files.size).toBe(1);

      // e volta para a fila do Admin
      const queue = (await call('GET', '/admin/ngos', await createAdmin(ctx.db))).json();
      expect(queue.data.map((n: { user_id: string }) => n.user_id)).toContain(ngo.id);
    });

    it('409 NGO_ALREADY_ACTIVE, 400 INVALID_DOCUMENT e 403 para doador', async () => {
      const ativa = await createNgo(ctx.db);
      const r1 = await resubmit(ativa, pdfBuffer());
      expect(r1.statusCode).toBe(409);
      expect(r1.json().error).toBe('NGO_ALREADY_ACTIVE');
      await expectContract(r1, 'PUT', '/profile/ngo-document');

      const pendente = await createNgo(ctx.db, { status: 'PENDENTE_APROVACAO' });
      const r2 = await resubmit(pendente, Buffer.from('texto'));
      expect(r2.statusCode).toBe(400);
      expect(r2.json().error).toBe('INVALID_DOCUMENT');

      expect((await resubmit(donor, pdfBuffer())).statusCode).toBe(403);
    });
  });

  describe('DELETE /profile', () => {
    it('doador: anonimiza, apaga itens disponíveis e fotos, mantém o DOADO; e-mail fica livre', async () => {
      const ngo = await createNgo(ctx.db);
      const disponivel = await createItem(ctx.db, donor);
      const doado = await createItem(ctx.db, donor, { status: 'DOADO', selected_ngo_id: ngo.id });
      for (let i = 0; i < 3; i++) await ctx.storage.upload('items', `${disponivel.id}/${i}.webp`, pdfBuffer(), 'image/webp');
      const token = (await login(donor.email, PASSWORD)).json().token;

      const res = await call('DELETE', '/profile', donor, { password: PASSWORD });
      expect(res.statusCode).toBe(204);
      await expectContract(res, 'DELETE', '/profile');

      const items = await ctx.db.sql`SELECT id FROM items WHERE donor_id = ${donor.id}`;
      expect(items.map((i) => i.id)).toEqual([doado.id]);
      expect(ctx.storage.files.size).toBe(0);
      const [user] = await ctx.db.sql`SELECT name, email, deleted_at FROM users WHERE id = ${donor.id}`;
      expect(user).toMatchObject({ name: 'Usuário removido', email: `removido+${donor.id}@conectadoacoes.invalid` });
      expect(user!.deleted_at).toBeInstanceOf(Date);

      expect((await call('GET', '/auth/me', token)).statusCode).toBe(401);
      expect((await login(donor.email, PASSWORD)).statusCode).toBe(401);
      const again = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register/donor',
        payload: { name: 'Marina', email: donor.email, password: PASSWORD, city: 'São Paulo', state: 'SP' },
      });
      expect(again.statusCode).toBe(201);

      // a ONG ainda vê a doação concluída no histórico, com a contraparte anonimizada
      const chats = (await call('GET', '/chats', ngo)).json();
      expect(chats.data[0].counterpart.name).toBe('Usuário removido');
    });

    it('ONG: remove curtidas abertas e o perfil (CNPJ livre); curtida de item doado fica', async () => {
      const ngo = await createNgo(ctx.db);
      const aberto = await createItem(ctx.db, donor);
      const doado = await createItem(ctx.db, donor, { status: 'DOADO', selected_ngo_id: ngo.id });
      await addInterest(ctx.db, aberto.id, ngo.id);
      await addInterest(ctx.db, doado.id, ngo.id);

      expect((await call('DELETE', '/profile', ngo, { password: PASSWORD })).statusCode).toBe(204);
      const interests = await ctx.db.sql`SELECT item_id FROM item_interests WHERE ngo_id = ${ngo.id}`;
      expect(interests.map((i) => i.item_id)).toEqual([doado.id]);
      expect(await ctx.db.sql`SELECT 1 FROM ngo_profiles WHERE user_id = ${ngo.id}`).toHaveLength(0);
      expect((await call('GET', `/items/${aberto.id}/interests`, donor)).json().total).toBe(0);
    });

    it('400 INVALID_CURRENT_PASSWORD e 409 HAS_ACTIVE_NEGOTIATIONS', async () => {
      const wrong = await call('DELETE', '/profile', donor, { password: 'Errada123' });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().error).toBe('INVALID_CURRENT_PASSWORD');
      await expectContract(wrong, 'DELETE', '/profile');

      const ngo = await createNgo(ctx.db);
      await createItem(ctx.db, donor, { status: 'EM_PROGRESSO', selected_ngo_id: ngo.id });
      for (const user of [donor, ngo]) {
        const res = await call('DELETE', '/profile', user, { password: PASSWORD });
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe('HAS_ACTIVE_NEGOTIATIONS');
        await expectContract(res, 'DELETE', '/profile');
      }
    });
  });
});
