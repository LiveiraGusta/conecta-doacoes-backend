import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from '../helpers/app';
import { expectContract } from '../helpers/contract';
import { createAdmin, createNgo, imageBuffer, PASSWORD, pdfBuffer, randomCnpj } from '../helpers/factories';
import { multipart, type FilePart } from '../helpers/multipart';

const donorBody = (over: Record<string, unknown> = {}) => ({
  name: 'Marina Souza',
  email: 'Marina@Teste.dev ',
  password: 'Senha1234',
  city: 'São Paulo',
  state: 'SP',
  ...over,
});

const ngoFields = (over: Record<string, string | undefined> = {}) => ({
  name: 'ONG Salvadora',
  email: 'contato@ongsalvadora.org.br',
  password: 'Senha1234',
  city: 'São Paulo',
  state: 'SP',
  cnpj: '11222333000181',
  website: 'https://ongsalvadora.org.br',
  ...over,
});

const doc = (content: Buffer, filename = 'cnpj.pdf'): FilePart => ({ field: 'document', filename, content });

describe('Módulo 1 — Autenticação', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await buildTestApp();
  });
  afterAll(() => closeTestApp(ctx));
  beforeEach(async () => {
    await resetDb(ctx.db);
    ctx.storage.files.clear();
  });

  const registerNgo = (fields: Record<string, string | undefined>, files: FilePart[]) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/auth/register/ngo', ...multipart(fields, files) });

  describe('POST /auth/register/donor', () => {
    it('201 com token, e-mail normalizado e sem ngo_profile', async () => {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/register/donor', payload: donorBody() });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.user).toMatchObject({ email: 'marina@teste.dev', role: 'DONOR' });
      expect(body.user).not.toHaveProperty('ngo_profile');
      expect(body.user).not.toHaveProperty('password_hash');
      await expectContract(res, 'POST', '/auth/register/donor');
    });

    it('409 EMAIL_TAKEN com o mesmo e-mail em outra caixa', async () => {
      await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/register/donor', payload: donorBody() });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register/donor',
        payload: donorBody({ email: 'MARINA@teste.dev' }),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('EMAIL_TAKEN');
      await expectContract(res, 'POST', '/auth/register/donor');
    });

    it('400 VALIDATION_ERROR com details por campo', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register/donor',
        payload: donorBody({ password: 'somenteletras', state: 'XX', name: '  ' }),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('VALIDATION_ERROR');
      expect(body.details.map((d: { path: string }) => d.path).sort()).toEqual(['name', 'password', 'state']);
      expect(body.details.find((d: { path: string }) => d.path === 'password').message).toBe(
        'A senha precisa de ao menos 1 letra e 1 número',
      );
      await expectContract(res, 'POST', '/auth/register/donor');
    });
  });

  describe('POST /auth/register/ngo', () => {
    it('201: ONG nasce PENDENTE_APROVACAO, CNPJ mascarado e sem document_url na resposta', async () => {
      const res = await registerNgo(ngoFields(), [doc(pdfBuffer())]);
      expect(res.statusCode).toBe(201);
      const { user } = res.json();
      expect(user.role).toBe('NGO');
      expect(user.ngo_profile).toEqual({
        id: expect.any(String),
        cnpj: '11.222.333/0001-81',
        website: 'https://ongsalvadora.org.br',
        status: 'PENDENTE_APROVACAO',
        rejection_reason: null,
      });
      expect([...ctx.storage.files.keys()][0]).toMatch(new RegExp(`^docs/${user.id}/[0-9a-f-]+\\.pdf$`));
      await expectContract(res, 'POST', '/auth/register/ngo');
    });

    it('aceita documento em imagem (PNG) e website vazio', async () => {
      const res = await registerNgo(ngoFields({ website: '' }), [doc(await imageBuffer('png'), 'cartao.png')]);
      expect(res.statusCode).toBe(201);
      expect(res.json().user.ngo_profile.website).toBeNull();
    });

    it.each([
      ['sem documento', async () => []],
      ['documento .pdf que não é PDF', async () => [doc(Buffer.from('texto qualquer'))]],
      ['dois documentos', async () => [doc(pdfBuffer()), doc(pdfBuffer(), 'outro.pdf')]],
      ['documento acima de 5 MB', async () => [doc(Buffer.concat([pdfBuffer(), Buffer.alloc(5 * 1024 * 1024)]))]],
    ])('400 INVALID_DOCUMENT: %s', async (_caso, files) => {
      const res = await registerNgo(ngoFields(), await files());
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('INVALID_DOCUMENT');
      expect(ctx.storage.files.size).toBe(0);
      await expectContract(res, 'POST', '/auth/register/ngo');
    });

    it('400 VALIDATION_ERROR com CNPJ inválido', async () => {
      const res = await registerNgo(ngoFields({ cnpj: '11.222.333/0001-82' }), [doc(pdfBuffer())]);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'VALIDATION_ERROR', details: [{ path: 'cnpj', message: 'CNPJ inválido' }] });
    });

    it('409 CNPJ_TAKEN', async () => {
      await registerNgo(ngoFields(), [doc(pdfBuffer())]);
      const res = await registerNgo(ngoFields({ email: 'outro@ong.dev', cnpj: '11.222.333/0001-81' }), [doc(pdfBuffer())]);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('CNPJ_TAKEN');
      await expectContract(res, 'POST', '/auth/register/ngo');
    });
  });

  describe('POST /auth/login e GET /auth/me', () => {
    it('login e me funcionam para os 3 perfis', async () => {
      await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/register/donor', payload: donorBody() });
      const ngo = await createNgo(ctx.db, { status: 'PENDENTE_APROVACAO' });
      const admin = await createAdmin(ctx.db);

      for (const [email, role] of [
        ['marina@teste.dev', 'DONOR'],
        [ngo.email, 'NGO'],
        [admin.email, 'ADMIN'],
      ] as const) {
        const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
        expect(login.statusCode, role).toBe(200);
        await expectContract(login, 'POST', '/auth/login');

        const me = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: { authorization: `Bearer ${login.json().token}` },
        });
        expect(me.statusCode).toBe(200);
        expect(me.json().user.role).toBe(role);
        await expectContract(me, 'GET', '/auth/me');
      }
    });

    it('ONG rejeitada vê o status e o motivo no login', async () => {
      const ngo = await createNgo(ctx.db, { status: 'REJEITADO', rejection_reason: 'Documento ilegível, reenvie.' });
      const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: ngo.email, password: PASSWORD } });
      expect(res.json().user.ngo_profile).toMatchObject({ status: 'REJEITADO', rejection_reason: 'Documento ilegível, reenvie.' });
    });

    it('401 INVALID_CREDENTIALS idêntico para e-mail inexistente e senha errada', async () => {
      const admin = await createAdmin(ctx.db);
      const wrong = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: admin.email, password: 'Errada123' } });
      const missing = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'nao@existe.dev', password: 'Errada123' } });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json()).toEqual(missing.json());
      expect(wrong.json().error).toBe('INVALID_CREDENTIALS');
      await expectContract(wrong, 'POST', '/auth/login');
    });

    it('401 no /auth/me sem token', async () => {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
      expect(res.statusCode).toBe(401);
      await expectContract(res, 'GET', '/auth/me');
    });
  });

  it('randomCnpj das factories gera CNPJs válidos (sanidade do helper)', async () => {
    const res = await registerNgo(ngoFields({ cnpj: randomCnpj() }), [doc(pdfBuffer())]);
    expect(res.statusCode).toBe(201);
  });
});
