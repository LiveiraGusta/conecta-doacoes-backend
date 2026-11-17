import sharp from 'sharp';
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
  imageBuffer,
  pdfBuffer,
  sessionCookie,
  tokenFromResponse,
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
      headers: typeof auth === 'string' ? { cookie: sessionCookie(auth) } : authHeader(ctx.app, auth),
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

  describe('PATCH /profile — página pessoal', () => {
    it('padrões no /auth/me: bio null e preferências padrão', async () => {
      const me = await call('GET', '/auth/me', donor);
      expect(me.json().user).toMatchObject({
        bio: null,
        preferences: { theme_color: 'AZUL', theme_mode: 'SYSTEM', show_donations: false },
      });
      await expectContract(me, 'GET', '/auth/me');
    });

    it('doador define e apaga a descrição (vazio vira null)', async () => {
      const set = await call('PATCH', '/profile', donor, { bio: '  Doo o que não uso mais.  ' });
      expect(set.json().user.bio).toBe('Doo o que não uso mais.');
      await expectContract(set, 'PATCH', '/profile');
      expect((await call('PATCH', '/profile', donor, { bio: '' })).json().user.bio).toBeNull();
      expect((await call('PATCH', '/profile', donor, { bio: 'a'.repeat(501) })).statusCode).toBe(400);
    });

    it('ONG grava contato, categorias e endereço normalizados', async () => {
      const ngo = await createNgo(ctx.db);
      const res = await call('PATCH', '/profile', ngo, {
        bio: 'Atendemos 200 famílias.',
        phone: '(11) 98765-4321',
        instagram: 'https://www.instagram.com/OngSalvadora/?hl=pt',
        accepted_categories: ['ROUPAS', 'LIVROS', 'ROUPAS'],
        address: { cep: '01310-100', street: 'Av. Paulista', number: '1000', neighborhood: 'Bela Vista' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.ngo_profile).toMatchObject({
        phone: '11987654321',
        instagram: 'ongsalvadora',
        accepted_categories: ['ROUPAS', 'LIVROS'],
        address: { cep: '01310100', street: 'Av. Paulista', number: '1000', complement: null, neighborhood: 'Bela Vista' },
      });
      await expectContract(res, 'PATCH', '/profile');

      // Só o que veio muda; null apaga.
      const cleared = (await call('PATCH', '/profile', ngo, { phone: null, address: null })).json().user.ngo_profile;
      expect(cleared).toMatchObject({ phone: null, address: null, instagram: 'ongsalvadora', accepted_categories: ['ROUPAS', 'LIVROS'] });
      expect((await call('PATCH', '/profile', ngo, { instagram: '@outra.ong' })).json().user.ngo_profile.instagram).toBe('outra.ong');
    });

    it.each([
      ['telefone sem DDD', { phone: '98765-4321' }, 'phone'],
      ['instagram com espaço', { instagram: 'ong salvadora' }, 'instagram'],
      ['categoria inexistente', { accepted_categories: ['MOVEIS'] }, 'accepted_categories.0'],
      ['CEP curto', { address: { cep: '0131', street: 'Rua A', number: '1', neighborhood: 'Centro' } }, 'address.cep'],
      ['endereço sem número', { address: { cep: '01310100', street: 'Rua A', neighborhood: 'Centro' } }, 'address.number'],
    ])('400 para ONG: %s', async (_caso, payload, path) => {
      const ngo = await createNgo(ctx.db);
      const res = await call('PATCH', '/profile', ngo, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().details).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
    });

    it('400 quando doador envia campos de ONG', async () => {
      const res = await call('PATCH', '/profile', donor, { phone: '11987654321', accepted_categories: ['ROUPAS'] });
      expect(res.statusCode).toBe(400);
      expect(res.json().details.map((d: { path: string }) => d.path)).toEqual(['phone', 'accepted_categories']);
    });
  });

  describe('/profile/preferences', () => {
    it('GET devolve os padrões; PATCH parcial mescla e aparece no /auth/me', async () => {
      const get = await call('GET', '/profile/preferences', donor);
      expect(get.json()).toEqual({ theme_color: 'AZUL', theme_mode: 'SYSTEM', show_donations: false });
      await expectContract(get, 'GET', '/profile/preferences');

      const patch = await call('PATCH', '/profile/preferences', donor, { theme_color: 'VERDE', show_donations: true });
      expect(patch.statusCode).toBe(200);
      expect(patch.json()).toEqual({ theme_color: 'VERDE', theme_mode: 'SYSTEM', show_donations: true });
      await expectContract(patch, 'PATCH', '/profile/preferences');

      expect((await call('PATCH', '/profile/preferences', donor, { theme_mode: 'DARK' })).json()).toEqual({
        theme_color: 'VERDE',
        theme_mode: 'DARK',
        show_donations: true,
      });
      expect((await call('GET', '/auth/me', donor)).json().user.preferences).toEqual({
        theme_color: 'VERDE',
        theme_mode: 'DARK',
        show_donations: true,
      });
    });

    it('ONG e Admin trocam o tema; show_donations é recusado para a ONG', async () => {
      const ngo = await createNgo(ctx.db);
      const admin = await createAdmin(ctx.db);
      expect((await call('PATCH', '/profile/preferences', ngo, { theme_color: 'ROSA' })).json().theme_color).toBe('ROSA');
      expect((await call('PATCH', '/profile/preferences', admin, { theme_mode: 'LIGHT' })).json().theme_mode).toBe('LIGHT');

      const res = await call('PATCH', '/profile/preferences', ngo, { show_donations: true });
      expect(res.statusCode).toBe(400);
      expect(res.json().details).toEqual([expect.objectContaining({ path: 'show_donations' })]);
      await expectContract(res, 'PATCH', '/profile/preferences');
    });

    it.each([
      ['corpo vazio', {}],
      ['cor fora da lista', { theme_color: 'AMARELO' }],
      ['modo fora da lista', { theme_mode: 'AUTO' }],
      ['show_donations não booleano', { show_donations: 'sim' }],
    ])('400: %s', async (_caso, payload) => {
      expect((await call('PATCH', '/profile/preferences', donor, payload)).statusCode).toBe(400);
    });

    it('a primeira alteração grava uma única linha em user_preferences', async () => {
      await call('PATCH', '/profile/preferences', donor, { theme_mode: 'DARK' });
      await call('PATCH', '/profile/preferences', donor, { theme_color: 'ROXO' });
      const [row] = await ctx.db.sql`SELECT count(*)::int AS n FROM user_preferences WHERE user_id = ${donor.id}`;
      expect(row!.n).toBe(1);
    });
  });

  describe('foto de perfil e banner', () => {
    const upload = (kind: 'avatar' | 'banner', who: Who, content: Buffer, field: string = kind) => {
      const body = multipart({}, [{ field, filename: 'imagem.png', content, contentType: 'image/png' }]);
      return ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/profile/${kind}`,
        payload: body.payload,
        headers: { ...body.headers, ...authHeader(ctx.app, who) },
      });
    };

    /** Arquivo gravado no bucket a partir da URL pública. */
    const storedOf = (url: string) => ctx.storage.files.get(`items/${ctx.storage.pathFromPublicUrl(url)!}`);

    it('avatar: qualquer proporção vira WEBP 512×512 em profiles/<id>/; trocar apaga o antigo', async () => {
      const wide = await sharp({ create: { width: 900, height: 300, channels: 3, background: '#0af' } }).png().toBuffer();
      const res = await upload('avatar', donor, wide);
      expect(res.statusCode).toBe(200);
      await expectContract(res, 'PUT', '/profile/avatar');
      const first = res.json().user.avatar_url as string;
      expect(first).toMatch(new RegExp(`/items/profiles/${donor.id}/avatar-[0-9a-f-]+\\.webp$`));
      const file = storedOf(first)!;
      expect(file.contentType).toBe('image/webp');
      expect(await sharp(file.body).metadata()).toMatchObject({ format: 'webp', width: 512, height: 512 });

      const second = (await upload('avatar', donor, await imageBuffer('png', 64))).json().user.avatar_url as string;
      expect(second).not.toBe(first);
      expect(storedOf(first)).toBeUndefined();
      expect(storedOf(second)).toBeDefined();
      expect((await call('GET', '/auth/me', donor)).json().user.avatar_url).toBe(second);
    });

    it('DELETE /profile/avatar volta para null e apaga o arquivo (idempotente)', async () => {
      const url = (await upload('avatar', donor, await imageBuffer('png', 64))).json().user.avatar_url as string;
      const res = await call('DELETE', '/profile/avatar', donor);
      expect(res.statusCode).toBe(200);
      expect(res.json().user.avatar_url).toBeNull();
      await expectContract(res, 'DELETE', '/profile/avatar');
      expect(storedOf(url)).toBeUndefined();
      expect((await call('DELETE', '/profile/avatar', donor)).statusCode).toBe(200);
    });

    it('banner: só ONG; vira WEBP 1500×500 e aparece em ngo_profile.banner_url', async () => {
      const ngo = await createNgo(ctx.db);
      const res = await upload('banner', ngo, await imageBuffer('jpeg', 200));
      expect(res.statusCode).toBe(200);
      await expectContract(res, 'PUT', '/profile/banner');
      const url = res.json().user.ngo_profile.banner_url as string;
      expect(await sharp(storedOf(url)!.body).metadata()).toMatchObject({ width: 1500, height: 500 });

      const cleared = await call('DELETE', '/profile/banner', ngo);
      expect(cleared.json().user.ngo_profile.banner_url).toBeNull();
      expect(storedOf(url)).toBeUndefined();

      expect((await upload('banner', donor, await imageBuffer('png', 64))).statusCode).toBe(403);
      expect((await call('DELETE', '/profile/banner', donor)).statusCode).toBe(403);
    });

    it('400 INVALID_PHOTO para PDF, campo errado ou 2 arquivos; 413 acima de 5 MB; nada fica no bucket', async () => {
      const pdf = await upload('avatar', donor, pdfBuffer());
      expect(pdf.statusCode).toBe(400);
      expect(pdf.json().error).toBe('INVALID_PHOTO');
      await expectContract(pdf, 'PUT', '/profile/avatar');

      expect((await upload('avatar', donor, await imageBuffer('png', 64), 'foto')).json().error).toBe('INVALID_PHOTO');

      const png = await imageBuffer('png', 64);
      const two = multipart({}, [
        { field: 'avatar', filename: 'a.png', content: png, contentType: 'image/png' },
        { field: 'avatar', filename: 'b.png', content: png, contentType: 'image/png' },
      ]);
      const res2 = await ctx.app.inject({
        method: 'PUT',
        url: '/api/v1/profile/avatar',
        payload: two.payload,
        headers: { ...two.headers, ...authHeader(ctx.app, donor) },
      });
      expect(res2.json().error).toBe('INVALID_PHOTO');

      const big = await upload('avatar', donor, Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]));
      expect(big.statusCode).toBe(413);
      expect(big.json().error).toBe('PAYLOAD_TOO_LARGE');

      expect(ctx.storage.files.size).toBe(0);
      expect((await call('GET', '/auth/me', donor)).json().user.avatar_url).toBeNull();
    });

    it('excluir a conta apaga a foto de perfil e o banner, e limpa bio e avatar', async () => {
      const ngo = await createNgo(ctx.db);
      await call('PATCH', '/profile', ngo, { bio: 'Sobre a ONG' });
      const avatar = (await upload('avatar', ngo, await imageBuffer('png', 64))).json().user.avatar_url as string;
      const banner = (await upload('banner', ngo, await imageBuffer('png', 64))).json().user.ngo_profile.banner_url as string;

      expect((await call('DELETE', '/profile', ngo, { password: PASSWORD })).statusCode).toBe(204);
      expect(storedOf(avatar)).toBeUndefined();
      expect(storedOf(banner)).toBeUndefined();
      const [row] = await ctx.db.sql`SELECT bio, avatar_url FROM users WHERE id = ${ngo.id}`;
      expect(row).toEqual({ bio: null, avatar_url: null });
    });
  });

  describe('PATCH /profile/password', () => {
    it('troca a senha, derruba as outras sessões e reemite o cookie desta', async () => {
      const old = tokenFromResponse(await login(donor.email, PASSWORD));
      const otherDevice = tokenFromResponse(await login(donor.email, PASSWORD));
      await new Promise((r) => setTimeout(r, 1100)); // tokens antigos: emitidos num segundo anterior à troca

      const res = await call('PATCH', '/profile/password', old, { current_password: PASSWORD, new_password: 'NovaSenha9' });
      expect(res.statusCode).toBe(204);
      await expectContract(res, 'PATCH', '/profile/password');

      // A sessão atual continua com o cookie novo; o token antigo e o do outro aparelho caem.
      const renewed = tokenFromResponse(res);
      expect(renewed).not.toBe(old);
      expect((await call('GET', '/auth/me', renewed)).statusCode).toBe(200);
      expect((await call('GET', '/auth/me', old)).statusCode).toBe(401);
      expect((await call('GET', '/auth/me', otherDevice)).statusCode).toBe(401);
      expect((await login(donor.email, PASSWORD)).statusCode).toBe(401);
      const fresh = await login(donor.email, 'NovaSenha9');
      expect(fresh.statusCode).toBe(200);
      expect((await call('GET', '/auth/me', tokenFromResponse(fresh))).statusCode).toBe(200);
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
      const token = tokenFromResponse(await login(donor.email, PASSWORD));

      const res = await call('DELETE', '/profile', donor, { password: PASSWORD });
      expect(res.statusCode).toBe(204);
      expect(res.cookies.find((c) => c.name === 'cd_session')).toMatchObject({ value: '' });
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
