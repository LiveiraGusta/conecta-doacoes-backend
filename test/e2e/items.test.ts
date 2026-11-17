import { randomUUID } from 'node:crypto';
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
  imageBuffer,
  pdfBuffer,
} from '../helpers/factories';
import { multipart, type FilePart } from '../helpers/multipart';

const photo = (content: Buffer, i = 0): FilePart => ({
  field: 'photos',
  filename: `foto${i}.jpg`,
  content,
  contentType: 'image/jpeg',
});

describe('Módulo 2 — Vitrine & Doações', () => {
  let ctx: TestContext;
  let donor: User;
  let jpg: Buffer;

  beforeAll(async () => {
    ctx = await buildTestApp();
    jpg = await imageBuffer('jpeg', 64);
  });
  afterAll(() => closeTestApp(ctx));
  beforeEach(async () => {
    await resetDb(ctx.db);
    ctx.storage.files.clear();
    donor = await createDonor(ctx.db, { name: 'Marina Souza' });
  });

  const publishOnce = (fields: Record<string, string | undefined>, files: FilePart[], user: Pick<User, 'id' | 'role'> = donor) => {
    const body = multipart(fields, files);
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      payload: body.payload,
      headers: { ...body.headers, ...authHeader(ctx.app, user) },
    });
  };

  const get = (url: string, user: Pick<User, 'id' | 'role'>) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: authHeader(ctx.app, user) });

  describe('POST /items', () => {
    const fields = { title: 'Casaco infantil', description: 'Tamanho 6, pouco usado', category: 'ROUPAS' };

    it('201: 3 fotos viram webp no Storage, item DISPONIVEL na cidade do doador, evento gravado', async () => {
      const res = await publishOnce(fields, [photo(jpg, 0), photo(jpg, 1), photo(jpg, 2)]);
      expect(res.statusCode).toBe(201);
      const item = res.json();
      expect(item).toMatchObject({
        donor_id: donor.id,
        status: 'DISPONIVEL',
        city: 'São Paulo',
        state: 'SP',
        selected_ngo_id: null,
        completed_at: null,
      });
      expect(item.photos).toHaveLength(3);
      for (const p of item.photos) expect(p.photo_url).toMatch(new RegExp(`/items/${item.id}/[0-9a-f-]+\\.webp$`));
      expect([...ctx.storage.files.values()].every((f) => f.contentType === 'image/webp')).toBe(true);
      await expectContract(res, 'POST', '/items');

      const events = await ctx.db.sql`SELECT from_status, to_status, actor_id FROM item_events WHERE item_id = ${item.id}`;
      expect(events).toEqual([{ from_status: null, to_status: 'DISPONIVEL', actor_id: donor.id }]);
    });

    it('preserva a ordem do upload: photos[0] é a 1ª foto enviada (a capa escolhida no front)', async () => {
      // Larguras diferentes identificam cada foto depois da conversão para WEBP.
      const widths = [40, 24, 32];
      const files = await Promise.all(widths.map((w, i) => imageBuffer('jpeg', w).then((b) => photo(b, i))));
      const created = (await publishOnce(fields, files)).json();
      const detail = (await ctx.app.inject({ method: 'GET', url: `/api/v1/items/${created.id}`, headers: authHeader(ctx.app, donor) })).json();

      for (const body of [created, detail]) {
        const stored = body.photos.map((p: { photo_url: string }) => {
          const path = ctx.storage.pathFromPublicUrl(p.photo_url)!;
          return ctx.storage.files.get(`items/${path}`)!.body;
        });
        const actual = await Promise.all(stored.map(async (b: Buffer) => (await sharp(b).metadata()).width));
        expect(actual).toEqual(widths);
      }
    });

    it.each([0, 2])('400 INVALID_PHOTO_COUNT com %i fotos', async (n) => {
      const res = await publishOnce(fields, Array.from({ length: n }, (_, i) => photo(jpg, i)));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'INVALID_PHOTO_COUNT', message: 'É obrigatório enviar exatamente 3 fotos do item.' });
      await expectContract(res, 'POST', '/items');
    });

    it('400 INVALID_PHOTO_COUNT com 4 fotos', async () => {
      const res = await publishOnce(fields, [0, 1, 2, 3].map((i) => photo(jpg, i)));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('INVALID_PHOTO_COUNT');
      expect(ctx.storage.files.size).toBe(0);
    });

    it('400 INVALID_PHOTO quando um arquivo não é imagem (mesmo com nome .jpg)', async () => {
      const res = await publishOnce(fields, [photo(jpg, 0), photo(jpg, 1), photo(pdfBuffer(), 2)]);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('INVALID_PHOTO');
      expect(ctx.storage.files.size).toBe(0);
      await expectContract(res, 'POST', '/items');
    });

    it('413 PAYLOAD_TOO_LARGE com foto acima de 5 MB', async () => {
      const big = Buffer.concat([jpg, Buffer.alloc(5 * 1024 * 1024)]);
      const res = await publishOnce(fields, [photo(jpg, 0), photo(big, 1), photo(jpg, 2)]);
      expect(res.statusCode).toBe(413);
      expect(res.json().error).toBe('PAYLOAD_TOO_LARGE');
      await expectContract(res, 'POST', '/items');
    });

    it('400 VALIDATION_ERROR com título curto e categoria fora do enum', async () => {
      const res = await publishOnce({ title: 'ab', category: 'CARROS' }, [0, 1, 2].map((i) => photo(jpg, i)));
      expect(res.statusCode).toBe(400);
      expect(res.json().details.map((d: { path: string }) => d.path).sort()).toEqual(['category', 'title']);
    });

    it('403 para ONG e Admin', async () => {
      for (const user of [await createNgo(ctx.db), await createAdmin(ctx.db)]) {
        const res = await publishOnce(fields, [0, 1, 2].map((i) => photo(jpg, i)), user);
        expect(res.statusCode).toBe(403);
        await expectContract(res, 'POST', '/items');
      }
    });
  });

  describe('GET /items/feed', () => {
    it('mostra só a cidade/UF de quem pede, sem DOADO, mais novos primeiro', async () => {
      const old = await createItem(ctx.db, donor, { created_at: new Date('2026-11-01T10:00:00Z') });
      const recent = await createItem(ctx.db, donor, { created_at: new Date('2026-11-10T10:00:00Z') });
      const emNegociacao = await createItem(ctx.db, donor, { status: 'EM_PROGRESSO', created_at: new Date('2026-11-05T10:00:00Z') });
      await createItem(ctx.db, donor, { status: 'DOADO' });
      await createItem(ctx.db, donor, { city: 'Campinas' });
      await createItem(ctx.db, donor, { city: 'São Paulo', state: 'RJ' });

      const ngo = await createNgo(ctx.db);
      const res = await get('/items/feed', ngo);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(3);
      expect(body.data.map((i: { id: string }) => i.id)).toEqual([recent.id, emNegociacao.id, old.id]);
      expect(body.data[0].donor).toEqual({ id: donor.id, name: 'Marina S.' });
      expect(body.data[0].photos).toHaveLength(3);
      await expectContract(res, 'GET', '/items/feed');

      const otherCity = await createNgo(ctx.db, { city: 'Campinas' });
      expect((await get('/items/feed', otherCity)).json().total).toBe(1);
    });

    it('filtra por categoria e busca no título e na descrição (curingas literais)', async () => {
      await createItem(ctx.db, donor, { title: 'Bicicleta aro 20', category: 'BRINQUEDOS' });
      await createItem(ctx.db, donor, { title: 'Livro', description: 'Coleção de BICICLETAS', category: 'LIVROS' });
      await createItem(ctx.db, donor, { title: 'Desconto 100%', category: 'ROUPAS' });
      await createItem(ctx.db, donor, { title: 'Casaco', category: 'ROUPAS' });

      const titles = async (q: string) =>
        (await get(`/items/feed${q}`, donor)).json().data.map((i: { title: string }) => i.title).sort();
      expect(await titles('?search=bicicleta')).toEqual(['Bicicleta aro 20', 'Livro']);
      expect(await titles('?search=bicicleta&category=LIVROS')).toEqual(['Livro']);
      expect(await titles('?search=100%25')).toEqual(['Desconto 100%']);
      expect(await titles('?search=%25')).toEqual(['Desconto 100%']);
      expect(await titles('?search=%20%20')).toHaveLength(4); // busca vazia depois do trim = sem filtro
    });

    it('pagina com limit/offset mantendo o total', async () => {
      for (let i = 0; i < 5; i++) await createItem(ctx.db, donor, { created_at: new Date(Date.UTC(2026, 10, i + 1)) });
      const body = (await get('/items/feed?limit=2&offset=4', donor)).json();
      expect(body.total).toBe(5);
      expect(body.data).toHaveLength(1);
      expect((await get('/items/feed?limit=0', donor)).statusCode).toBe(400);
      expect((await get('/items/feed?limit=51', donor)).statusCode).toBe(400);
    });

    it('has_user_interest e interests_count; ONG pendente sempre vê false', async () => {
      const item = await createItem(ctx.db, donor);
      const ativa = await createNgo(ctx.db);
      const outra = await createNgo(ctx.db);
      await addInterest(ctx.db, item.id, ativa.id);
      await addInterest(ctx.db, item.id, outra.id);
      expect((await get('/items/feed', ativa)).json().data[0]).toMatchObject({ has_user_interest: true, interests_count: 2 });

      // ONG que curtiu e depois foi rejeitada
      await ctx.db.sql`UPDATE ngo_profiles SET status = 'REJEITADO', rejection_reason = 'Motivo qualquer' WHERE user_id = ${outra.id}`;
      expect((await get('/items/feed', outra)).json().data[0]).toMatchObject({ has_user_interest: false, interests_count: 2 });
    });

    it('is_selected só para a ONG escolhida', async () => {
      const escolhida = await createNgo(ctx.db);
      const outra = await createNgo(ctx.db);
      await createItem(ctx.db, donor, { status: 'EM_PROGRESSO', selected_ngo_id: escolhida.id });
      expect((await get('/items/feed', escolhida)).json().data[0].is_selected).toBe(true);
      expect((await get('/items/feed', outra)).json().data[0].is_selected).toBe(false);
    });

    it('403 para Admin', async () => {
      const res = await get('/items/feed', await createAdmin(ctx.db));
      expect(res.statusCode).toBe(403);
      await expectContract(res, 'GET', '/items/feed');
    });
  });

  describe('GET /items/me', () => {
    it('doador vê as próprias doações (inclusive DOADO e de outra cidade), com filtro de status', async () => {
      await createItem(ctx.db, donor);
      await createItem(ctx.db, donor, { status: 'DOADO' });
      await createItem(ctx.db, donor, { city: 'Campinas' });
      await createItem(ctx.db, await createDonor(ctx.db));

      const all = await get('/items/me', donor);
      expect(all.json().total).toBe(3);
      await expectContract(all, 'GET', '/items/me');
      expect((await get('/items/me?status=DOADO', donor)).json().total).toBe(1);
    });

    it('ONG vê os itens que curtiu', async () => {
      const ngo = await createNgo(ctx.db);
      const liked = await createItem(ctx.db, donor);
      await createItem(ctx.db, donor);
      await addInterest(ctx.db, liked.id, ngo.id);

      const body = (await get('/items/me', ngo)).json();
      expect(body.data.map((i: { id: string }) => i.id)).toEqual([liked.id]);
      expect(body.data[0].has_user_interest).toBe(true);
    });
  });

  describe('GET /items/:itemId', () => {
    it('200 com fotos na ordem de envio e contexto do usuário', async () => {
      const item = await createItem(ctx.db, donor);
      const res = await get(`/items/${item.id}`, donor);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.photos.map((p: { photo_url: string }) => p.photo_url.slice(-6))).toEqual(['0.webp', '1.webp', '2.webp']);
      expect(body).toMatchObject({ donor: { name: 'Marina S.' }, interests_count: 0, is_selected: false });
      await expectContract(res, 'GET', '/items/{itemId}');
    });

    it('404 ITEM_NOT_FOUND e 400 para id que não é UUID', async () => {
      const res = await get(`/items/${randomUUID()}`, donor);
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('ITEM_NOT_FOUND');
      await expectContract(res, 'GET', '/items/{itemId}');
      expect((await get('/items/nao-e-uuid', donor)).statusCode).toBe(400);
    });
  });
});
