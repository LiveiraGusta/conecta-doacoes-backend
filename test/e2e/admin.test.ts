import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/types';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from '../helpers/app';
import { expectContract } from '../helpers/contract';
import { authHeader, createAdmin, createDonor, createNgo } from '../helpers/factories';

describe('Módulo 1 — Moderação de ONGs', () => {
  let ctx: TestContext;
  let admin: User;
  beforeAll(async () => {
    ctx = await buildTestApp();
  });
  afterAll(() => closeTestApp(ctx));
  beforeEach(async () => {
    await resetDb(ctx.db);
    admin = await createAdmin(ctx.db);
  });

  const list = (query = '', user: Pick<User, 'id' | 'role'> = admin) =>
    ctx.app.inject({ method: 'GET', url: `/api/v1/admin/ngos${query}`, headers: authHeader(ctx.app, user) });

  const patch = (id: string, payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/ngos/${id}/status`,
      headers: authHeader(ctx.app, admin),
      payload,
    });

  describe('GET /admin/ngos', () => {
    it('lista pendentes por padrão, mais antigas primeiro, com URL assinada', async () => {
      const first = await createNgo(ctx.db, { status: 'PENDENTE_APROVACAO' });
      const second = await createNgo(ctx.db, { status: 'PENDENTE_APROVACAO' });
      await createNgo(ctx.db, { status: 'ATIVO' });

      const res = await list();
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(2);
      expect(body.data.map((n: { user_id: string }) => n.user_id)).toEqual([first.id, second.id]);
      expect(body.data[0].document_url).toMatch(/^https:\/\/storage\.test\/ngo-docs\/.+\?token=fake&expires=600$/);
      await expectContract(res, 'GET', '/admin/ngos');
    });

    it('filtra por status e pagina mantendo o total', async () => {
      for (let i = 0; i < 3; i++) await createNgo(ctx.db, { status: 'ATIVO' });
      const res = await list('?status=ATIVO&limit=2&offset=2');
      expect(res.json()).toMatchObject({ total: 3, data: [expect.any(Object)] });
    });

    it('403 FORBIDDEN para doador e ONG', async () => {
      for (const user of [await createDonor(ctx.db), await createNgo(ctx.db)]) {
        const res = await list('', user);
        expect(res.statusCode).toBe(403);
        await expectContract(res, 'GET', '/admin/ngos');
      }
    });

    it('400 com status ou limit fora do contrato', async () => {
      expect((await list('?status=QUALQUER')).statusCode).toBe(400);
      expect((await list('?limit=51')).statusCode).toBe(400);
    });
  });

  describe('PATCH /admin/ngos/:id/status', () => {
    it('aprovar vale na hora para a ONG, sem novo login', async () => {
      const ngo = await createNgo(ctx.db, { status: 'PENDENTE_APROVACAO' });
      const res = await patch(ngo.ngo_profile_id, { status: 'ATIVO', rejection_reason: 'ignorado ao aprovar' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: ngo.ngo_profile_id, status: 'ATIVO', rejection_reason: null });
      await expectContract(res, 'PATCH', '/admin/ngos/{ngoProfileId}/status');

      const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader(ctx.app, ngo) });
      expect(me.json().user.ngo_profile.status).toBe('ATIVO');
    });

    it('rejeitar exige motivo com 10+ caracteres', async () => {
      const ngo = await createNgo(ctx.db, { status: 'PENDENTE_APROVACAO' });
      const semMotivo = await patch(ngo.ngo_profile_id, { status: 'REJEITADO' });
      expect(semMotivo.statusCode).toBe(400);
      expect(semMotivo.json().details).toEqual([
        { path: 'rejection_reason', message: 'Informe o motivo da rejeição (mínimo de 10 caracteres)' },
      ]);

      const ok = await patch(ngo.ngo_profile_id, { status: 'REJEITADO', rejection_reason: 'Documento ilegível.' });
      expect(ok.json()).toMatchObject({ status: 'REJEITADO', rejection_reason: 'Documento ilegível.' });
      await expectContract(ok, 'PATCH', '/admin/ngos/{ngoProfileId}/status');
    });

    it('pode reativar uma ONG rejeitada; não aceita voltar para PENDENTE_APROVACAO', async () => {
      const ngo = await createNgo(ctx.db, { status: 'REJEITADO', rejection_reason: 'Motivo anterior.' });
      expect((await patch(ngo.ngo_profile_id, { status: 'PENDENTE_APROVACAO' })).statusCode).toBe(400);
      expect((await patch(ngo.ngo_profile_id, { status: 'ATIVO' })).json()).toMatchObject({
        status: 'ATIVO',
        rejection_reason: null,
      });
    });

    it('404 NGO_NOT_FOUND', async () => {
      const res = await patch(randomUUID(), { status: 'ATIVO' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('NGO_NOT_FOUND');
      await expectContract(res, 'PATCH', '/admin/ngos/{ngoProfileId}/status');
    });
  });
});
