import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EmailMessage } from '../../src/core/email';
import type { User } from '../../src/types';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from '../helpers/app';
import { authHeader, createAdmin, createDonor, createItem, PASSWORD, pdfBuffer } from '../helpers/factories';
import { multipart } from '../helpers/multipart';

type Who = Pick<User, 'id' | 'role'>;

/**
 * Jornada completa pela API, conferindo cada e-mail de notificação: quem recebe, assunto e link.
 * O envio é fake (caixa de saída em memória); `take()` espera os envios em segundo plano.
 */
describe('Notificações por e-mail — jornada completa', () => {
  let ctx: TestContext;
  let admin: User;

  beforeAll(async () => {
    ctx = await buildTestApp();
  });
  afterAll(() => closeTestApp(ctx));
  beforeEach(async () => {
    await ctx.flushEmails();
    await resetDb(ctx.db);
    ctx.outbox.length = 0;
    admin = await createAdmin(ctx.db, { name: 'Ana Admin', email: 'ana@admin.dev' });
  });

  /** Espera os envios e devolve (e esvazia) a caixa de saída. */
  const take = async (): Promise<EmailMessage[]> => {
    const mails = [...(await ctx.flushEmails())];
    ctx.outbox.length = 0;
    return mails;
  };
  const only = async (to: string) => {
    const mails = await take();
    expect(mails.map((m) => m.to)).toEqual([to]);
    return mails[0]!;
  };

  const call = (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, user: Who, payload?: object) =>
    ctx.app.inject({ method, url: `/api/v1${url}`, headers: authHeader(ctx.app, user), payload });

  const registerNgo = () => {
    const body = multipart(
      {
        name: 'Casa Esperança',
        email: 'casa@ong.dev',
        password: PASSWORD,
        city: 'São Paulo',
        state: 'SP',
        cnpj: '11222333000181',
      },
      [{ field: 'document', filename: 'cnpj.pdf', content: pdfBuffer() }],
    );
    return ctx.app.inject({ method: 'POST', url: '/api/v1/auth/register/ngo', ...body });
  };

  const resubmit = (ngo: Who) => {
    const body = multipart({}, [{ field: 'document', filename: 'cnpj.pdf', content: pdfBuffer() }]);
    return ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/profile/ngo-document',
      payload: body.payload,
      headers: { ...body.headers, ...authHeader(ctx.app, ngo) },
    });
  };

  it('do cadastro da ONG até a doação concluída', async () => {
    // 1. ONG se cadastra: confirmação para ela e aviso para o administrador.
    const reg = await registerNgo();
    expect(reg.statusCode).toBe(201);
    const ngo: Who & { profileId: string } = { id: reg.json().user.id, role: 'NGO', profileId: reg.json().user.ngo_profile.id };
    const welcomeNgo = await take();
    expect(welcomeNgo.map((m) => m.to).sort()).toEqual(['ana@admin.dev', 'casa@ong.dev']);
    expect(welcomeNgo.find((m) => m.to === 'casa@ong.dev')!.subject).toContain('Cadastro recebido');
    expect(welcomeNgo.find((m) => m.to === 'ana@admin.dev')!.subject).toContain('Nova ONG para análise: Casa Esperança');

    // 2. Administrador rejeita: a ONG recebe o motivo.
    const reason = 'O documento está ilegível. Envie uma cópia mais nítida.';
    expect((await call('PATCH', `/admin/ngos/${ngo.profileId}/status`, admin, { status: 'REJEITADO', rejection_reason: reason })).statusCode).toBe(200);
    const rejected = await only('casa@ong.dev');
    expect(rejected.subject).toContain('Cadastro não aprovado');
    expect(rejected.text).toContain(reason);

    // 3. ONG reenvia o documento: o administrador é avisado.
    expect((await resubmit(ngo)).statusCode).toBe(200);
    expect((await only('ana@admin.dev')).subject).toContain('Documento reenviado: Casa Esperança');

    // 4. Administrador aprova.
    expect((await call('PATCH', `/admin/ngos/${ngo.profileId}/status`, admin, { status: 'ATIVO' })).statusCode).toBe(200);
    expect((await only('casa@ong.dev')).subject).toContain('ONG aprovada');

    // 5. Doador se cadastra: boas-vindas.
    const donorRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register/donor',
      payload: { name: 'Marina Souza', email: 'marina@teste.dev', password: PASSWORD, city: 'São Paulo', state: 'SP' },
    });
    expect(donorRes.statusCode).toBe(201);
    const donor: Who = { id: donorRes.json().user.id, role: 'DONOR' };
    expect((await only('marina@teste.dev')).subject).toContain('Boas-vindas');

    // 6. ONG demonstra interesse: o doador é avisado.
    const item = await createItem(ctx.db, { id: donor.id, city: 'São Paulo', state: 'SP' }, { title: 'Casaco infantil' });
    expect((await call('POST', `/items/${item.id}/interest`, ngo)).statusCode).toBe(201);
    const interest = await only('marina@teste.dev');
    expect(interest.subject).toContain('Nova ONG interessada em "Casaco infantil"');
    expect(interest.text).toContain(`/donations/${item.id}/interests`);

    // 7. Doador escolhe a ONG: a ONG é avisada, com o link da conversa.
    expect((await call('POST', `/items/${item.id}/select-ngo`, donor, { ngo_id: ngo.id })).statusCode).toBe(200);
    const selected = await only('casa@ong.dev');
    expect(selected.subject).toContain('foi escolhida');
    expect(selected.text).toContain(`/chats/${item.id}`);

    // 8. Mensagem no chat não gera e-mail.
    expect((await call('POST', `/chats/${item.id}/messages`, ngo, { message: 'Oi! Posso buscar amanhã?' })).statusCode).toBe(201);
    expect(await take()).toEqual([]);

    // 9. Denúncia: o administrador é avisado.
    expect((await call('POST', `/chats/${item.id}/report`, donor, { reason: 'Mensagens fora do combinado.' })).statusCode).toBe(201);
    expect((await only('ana@admin.dev')).subject).toContain('Nova denúncia sobre "Casaco infantil"');

    // 10. Doador cancela: a ONG é avisada, com o motivo.
    expect((await call('POST', `/items/${item.id}/cancel`, donor, { reason: 'Imprevisto na logística' })).statusCode).toBe(200);
    const cancelled = await only('casa@ong.dev');
    expect(cancelled.subject).toContain('Negociação cancelada');
    expect(cancelled.text).toContain('Imprevisto na logística');

    // 11. Nova escolha e confirmação do recebimento: o doador é avisado.
    expect((await call('POST', `/items/${item.id}/select-ngo`, donor, { ngo_id: ngo.id })).statusCode).toBe(200);
    await take();
    expect((await call('POST', `/items/${item.id}/confirm-receipt`, ngo)).statusCode).toBe(200);
    const done = await only('marina@teste.dev');
    expect(done.subject).toContain('Doação concluída');
    expect(done.text).toContain('Casa Esperança confirmou');
  });

  it('troca de senha no perfil gera aviso de segurança', async () => {
    const donor = await createDonor(ctx.db, { email: 'marina@teste.dev' });
    const res = await call('PATCH', '/profile/password', donor, { current_password: PASSWORD, new_password: 'NovaSenha9' });
    expect(res.statusCode).toBe(204);
    expect((await only('marina@teste.dev')).subject).toContain('senha foi alterada');
  });

  it('exclusão de conta: e-mail vai para o endereço real, não para o anonimizado', async () => {
    const donor = await createDonor(ctx.db, { email: 'marina@teste.dev' });
    expect((await call('DELETE', '/profile', donor, { password: PASSWORD })).statusCode).toBe(204);
    expect((await only('marina@teste.dev')).subject).toContain('Conta excluída');
  });

  it('falha no provedor de e-mail não muda a resposta da API', async () => {
    const failing = await buildTestApp();
    try {
      failing.outbox.push = () => {
        throw new Error('provedor fora do ar');
      };
      const res = await failing.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register/donor',
        payload: { name: 'Bia', email: 'bia@teste.dev', password: PASSWORD, city: 'São Paulo', state: 'SP' },
      });
      expect(res.statusCode).toBe(201);
      await failing.flushEmails();
    } finally {
      await closeTestApp(failing);
    }
  });
});
