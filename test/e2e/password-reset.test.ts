import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EmailMessage } from '../../src/core/email';
import type { User } from '../../src/types';
import { buildTestApp, closeTestApp, resetDb, type TestContext } from '../helpers/app';
import { expectContract } from '../helpers/contract';
import { authHeader, createDonor, PASSWORD } from '../helpers/factories';

describe('V1.1 — Recuperação de senha', () => {
  let ctx: TestContext;
  let donor: User;

  beforeAll(async () => {
    ctx = await buildTestApp();
  });
  afterAll(() => closeTestApp(ctx));
  beforeEach(async () => {
    await resetDb(ctx.db);
    ctx.outbox.length = 0;
    donor = await createDonor(ctx.db, { name: 'Marina Souza' });
  });

  const post = (url: string, payload: object) => ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, payload });
  const forgot = (email: string) => post('/auth/password/forgot', { email });
  const reset = (token: string, new_password = 'NovaSenha9') => post('/auth/password/reset', { token, new_password });
  const login = (password: string) => post('/auth/login', { email: donor.email, password });
  const tokenFrom = (m: EmailMessage) => new URL(m.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
  /** Tira o pedido mais recente da janela de 60 s, para o teste poder pedir outro link. */
  const skipCooldown = () => ctx.db.sql`UPDATE password_resets SET created_at = created_at - INTERVAL '2 minutes'`;

  it('202 sem revelar nada quando o e-mail não existe', async () => {
    const res = await forgot('ninguem@teste.dev');
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
    await expectContract(res, 'POST', '/auth/password/forgot');
    expect(ctx.outbox).toHaveLength(0);
  });

  it('fluxo completo: e-mail → nova senha → sessões antigas caem → link não reaproveita', async () => {
    const oldToken = (await login(PASSWORD)).json().token;
    await new Promise((r) => setTimeout(r, 1100)); // o JWT antigo precisa ser de um segundo anterior ao reset

    const res = await forgot(`  ${donor.email.toUpperCase()} `); // e-mail normalizado como no login
    expect(res.statusCode).toBe(202);
    await expectContract(res, 'POST', '/auth/password/forgot');
    expect(ctx.outbox).toHaveLength(1);
    expect(ctx.outbox[0]).toMatchObject({ to: donor.email, subject: expect.stringContaining('Redefinição') });
    const token = tokenFrom(ctx.outbox[0]!);

    // só o hash fica no banco
    const [row] = await ctx.db.sql<{ token_hash: string }[]>`SELECT token_hash FROM password_resets`;
    expect(row!.token_hash).not.toBe(token);

    const ok = await reset(token);
    expect(ok.statusCode).toBe(204);
    await expectContract(ok, 'POST', '/auth/password/reset');

    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${oldToken}` } })).statusCode).toBe(401);
    expect((await login(PASSWORD)).statusCode).toBe(401);
    expect((await login('NovaSenha9')).statusCode).toBe(200);

    const again = await reset(token, 'OutraSenha7');
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('INVALID_RESET_TOKEN');
    await expectContract(again, 'POST', '/auth/password/reset');
  });

  it('pedido repetido em menos de 60 s não manda outro e-mail', async () => {
    await forgot(donor.email);
    expect((await forgot(donor.email)).statusCode).toBe(202);
    expect(ctx.outbox).toHaveLength(1);
  });

  it('link novo invalida o anterior', async () => {
    await forgot(donor.email);
    await skipCooldown();
    await forgot(donor.email);
    expect(ctx.outbox).toHaveLength(2);
    const [first, second] = ctx.outbox.map(tokenFrom);
    expect((await reset(first!)).json().error).toBe('INVALID_RESET_TOKEN');
    expect((await reset(second!)).statusCode).toBe(204);
  });

  it('link expirado (30 min) é recusado', async () => {
    await forgot(donor.email);
    await ctx.db.sql`UPDATE password_resets SET expires_at = NOW() - INTERVAL '1 second'`;
    const res = await reset(tokenFrom(ctx.outbox[0]!));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_RESET_TOKEN');
  });

  it('duas redefinições simultâneas com o mesmo link: só uma vale', async () => {
    await forgot(donor.email);
    const token = tokenFrom(ctx.outbox[0]!);
    const results = await Promise.all([reset(token, 'Primeira11'), reset(token, 'Segunda22')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([204, 400]);
  });

  it('conta excluída depois do pedido: o link deixa de valer', async () => {
    await forgot(donor.email);
    const token = tokenFrom(ctx.outbox[0]!);
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/profile',
      headers: authHeader(ctx.app, donor),
      payload: { password: PASSWORD },
    });
    expect(del.statusCode).toBe(204);
    expect((await reset(token)).json().error).toBe('INVALID_RESET_TOKEN');
  });

  it.each([
    ['senha nova fora da regra', '/auth/password/reset', { token: 'abc', new_password: 'curta1' }],
    ['token vazio', '/auth/password/reset', { token: '', new_password: 'NovaSenha9' }],
    ['e-mail inválido', '/auth/password/forgot', { email: 'nao-e-email' }],
  ])('400 VALIDATION_ERROR: %s', async (_caso, url, payload) => {
    const res = await post(url, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
    await expectContract(res, 'POST', url);
  });
});
