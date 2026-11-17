import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/types';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from '../helpers/app';
import { expectContract } from '../helpers/contract';
import { addInterest, authHeader, createAdmin, createDonor, createItem, createNgo, PASSWORD } from '../helpers/factories';

type Who = Pick<User, 'id' | 'role'>;
const REASON = 'Pediu dinheiro para retirar a doação.';

describe('V1.1 — Denúncias', () => {
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

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, who: Who, payload?: object) =>
    ctx.app.inject({ method, url: `/api/v1${url}`, headers: authHeader(ctx.app, who), payload });
  const report = (itemId: string, who: Who, reason = REASON) => call('POST', `/chats/${itemId}/report`, who, { reason });
  const inProgress = () => createItem(ctx.db, donor, { status: 'EM_PROGRESSO', selected_ngo_id: ngo.id });

  describe('POST /chats/:itemId/report', () => {
    it('cada parte denuncia a outra; segunda denúncia aberta é 409 ALREADY_REPORTED', async () => {
      const item = await inProgress();

      const byNgo = await report(item.id, ngo);
      expect(byNgo.statusCode).toBe(201);
      expect(byNgo.json()).toMatchObject({ item_id: item.id, reporter_id: ngo.id, reported_id: donor.id, status: 'ABERTA' });
      await expectContract(byNgo, 'POST', '/chats/{itemId}/report');

      const byDonor = await report(item.id, donor);
      expect(byDonor.json()).toMatchObject({ reporter_id: donor.id, reported_id: ngo.id });

      const again = await report(item.id, ngo);
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe('ALREADY_REPORTED');
      await expectContract(again, 'POST', '/chats/{itemId}/report');
    });

    it('item DOADO também pode ser denunciado (histórico)', async () => {
      const item = await createItem(ctx.db, donor, { status: 'DOADO', selected_ngo_id: ngo.id });
      expect((await report(item.id, donor)).statusCode).toBe(201);
    });

    it('depois de resolvida, o mesmo usuário pode abrir outra', async () => {
      const item = await inProgress();
      const first = (await report(item.id, ngo)).json();
      await call('PATCH', `/admin/reports/${first.id}`, admin, { status: 'RESOLVIDA' });
      expect((await report(item.id, ngo)).statusCode).toBe(201);
    });

    it('duas denúncias simultâneas: só uma é criada', async () => {
      const item = await inProgress();
      const codes = (await Promise.all([report(item.id, ngo), report(item.id, ngo)])).map((r) => r.statusCode);
      expect(codes.sort()).toEqual([201, 409]);
    });

    it('404, 403 para quem não participa, CHAT_CLOSED com item disponível, 403 para Admin', async () => {
      const outsider = await createNgo(ctx.db);
      const item = await inProgress();
      const disponivel = await createItem(ctx.db, donor);
      await addInterest(ctx.db, disponivel.id, ngo.id);

      const cases: [string, Who, number, string][] = [
        ['00000000-0000-4000-8000-000000000000', donor, 404, 'ITEM_NOT_FOUND'],
        [item.id, outsider, 403, 'FORBIDDEN'],
        [disponivel.id, donor, 409, 'CHAT_CLOSED'],
        [disponivel.id, ngo, 403, 'FORBIDDEN'],
        [item.id, admin, 403, 'FORBIDDEN'],
      ];
      for (const [itemId, who, status, error] of cases) {
        const res = await report(itemId, who);
        expect(res.statusCode, error).toBe(status);
        expect(res.json().error).toBe(error);
        await expectContract(res, 'POST', '/chats/{itemId}/report');
      }
    });

    it('400 com motivo curto demais', async () => {
      const res = await report((await inProgress()).id, ngo, 'curto');
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('VALIDATION_ERROR');
      await expectContract(res, 'POST', '/chats/{itemId}/report');
    });
  });

  describe('Admin', () => {
    it('fila: abertas por padrão, mais antigas primeiro; filtro RESOLVIDA', async () => {
      const a = await inProgress();
      const b = await createItem(ctx.db, donor, { status: 'DOADO', selected_ngo_id: ngo.id, title: 'Livros' });
      const first = (await report(a.id, ngo)).json();
      const second = (await report(b.id, donor)).json();
      await ctx.db.sql`UPDATE reports SET created_at = NOW() - INTERVAL '1 hour' WHERE id = ${second.id}`;

      const res = await call('GET', '/admin/reports', admin);
      expect(res.statusCode).toBe(200);
      await expectContract(res, 'GET', '/admin/reports');
      expect(res.json().total).toBe(2);
      expect(res.json().data.map((r: { id: string }) => r.id)).toEqual([second.id, first.id]);
      expect(res.json().data[0]).toMatchObject({
        item: { id: b.id, title: 'Livros', status: 'DOADO' },
        reporter: { id: donor.id, name: 'Marina Souza', role: 'DONOR' },
        reported: { id: ngo.id, name: 'ONG Abrigo', role: 'NGO' },
      });

      await call('PATCH', `/admin/reports/${first.id}`, admin, { status: 'RESOLVIDA' });
      const resolved = (await call('GET', '/admin/reports?status=RESOLVIDA', admin)).json();
      expect(resolved.data.map((r: { id: string }) => r.id)).toEqual([first.id]);
      expect((await call('GET', '/admin/reports', admin)).json().total).toBe(1);
    });

    it('detalhe traz eventos e TODAS as mensagens do item, inclusive da negociação anterior', async () => {
      const ngo2 = await createNgo(ctx.db, { name: 'ONG Segunda' });
      const item = await createItem(ctx.db, donor);
      await addInterest(ctx.db, item.id, ngo.id);
      await addInterest(ctx.db, item.id, ngo2.id);

      // 1ª negociação: com a ONG Abrigo, cancelada
      await call('POST', `/items/${item.id}/select-ngo`, donor, { ngo_id: ngo.id });
      await call('POST', `/chats/${item.id}/messages`, ngo, { message: 'Mensagem da primeira ONG' });
      await call('POST', `/items/${item.id}/cancel`, donor, { reason: 'Não respondeu' });
      // 2ª negociação: com a ONG Segunda, que denuncia o doador
      await call('POST', `/items/${item.id}/select-ngo`, donor, { ngo_id: ngo2.id });
      await call('POST', `/chats/${item.id}/messages`, donor, { message: 'Mensagem para a segunda ONG' });
      const created = (await report(item.id, ngo2)).json();

      const res = await call('GET', `/admin/reports/${created.id}`, admin);
      expect(res.statusCode).toBe(200);
      await expectContract(res, 'GET', '/admin/reports/{reportId}');
      const body = res.json();
      expect(body.report).toMatchObject({ id: created.id, status: 'ABERTA', reason: REASON });
      expect(body.item).toMatchObject({ id: item.id, status: 'EM_PROGRESSO', donor_id: donor.id, selected_ngo_id: ngo2.id });
      expect(body.reporter).toMatchObject({ id: ngo2.id, role: 'NGO', email: ngo2.email });
      expect(body.reported).toMatchObject({ id: donor.id, role: 'DONOR', email: donor.email, ngo_profile_id: null });
      expect(body.messages.map((m: { message: string }) => m.message)).toEqual([
        'Mensagem da primeira ONG',
        'Mensagem para a segunda ONG',
      ]);
      expect(body.events.map((e: { to_status: string }) => e.to_status)).toEqual([
        'EM_PROGRESSO',
        'CANCELADO',
        'DISPONIVEL',
        'EM_PROGRESSO',
      ]);
    });

    it('ONG denunciada vem com ngo_profile_id; conta excluída aparece anonimizada', async () => {
      const item = await createItem(ctx.db, donor, { status: 'DOADO', selected_ngo_id: ngo.id });
      const created = (await report(item.id, donor)).json();
      expect((await call('DELETE', '/profile', donor, { password: PASSWORD })).statusCode).toBe(204);

      const body = (await call('GET', `/admin/reports/${created.id}`, admin)).json();
      const [profile] = await ctx.db.sql`SELECT id FROM ngo_profiles WHERE user_id = ${ngo.id}`;
      expect(body.reported.ngo_profile_id).toBe(profile!.id);
      expect(body.reporter.name).toBe('Usuário removido');
    });

    it('resolver é idempotente e grava quem resolveu', async () => {
      const created = (await report((await inProgress()).id, ngo)).json();
      const res = await call('PATCH', `/admin/reports/${created.id}`, admin, { status: 'RESOLVIDA' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('RESOLVIDA');
      await expectContract(res, 'PATCH', '/admin/reports/{reportId}');

      const again = await call('PATCH', `/admin/reports/${created.id}`, admin, { status: 'RESOLVIDA' });
      expect(again.statusCode).toBe(200);
      const [row] = await ctx.db.sql`SELECT resolved_by, resolved_at FROM reports WHERE id = ${created.id}`;
      expect(row).toMatchObject({ resolved_by: admin.id, resolved_at: expect.any(Date) });
    });

    it('404 REPORT_NOT_FOUND, 400 com id ou status inválido, 403 para quem não é Admin', async () => {
      const missing = '00000000-0000-4000-8000-000000000000';
      for (const [method, payload] of [['GET', undefined], ['PATCH', { status: 'RESOLVIDA' }]] as const) {
        const res = await call(method, `/admin/reports/${missing}`, admin, payload);
        expect(res.statusCode).toBe(404);
        expect(res.json().error).toBe('REPORT_NOT_FOUND');
        await expectContract(res, method, '/admin/reports/{reportId}');
      }
      expect((await call('GET', '/admin/reports/nao-e-uuid', admin)).statusCode).toBe(400);
      expect((await call('PATCH', `/admin/reports/${missing}`, admin, { status: 'ABERTA' })).statusCode).toBe(400);
      expect((await call('GET', '/admin/reports', donor)).statusCode).toBe(403);
      expect((await call('GET', `/admin/reports/${missing}`, ngo)).statusCode).toBe(403);
    });
  });
});
