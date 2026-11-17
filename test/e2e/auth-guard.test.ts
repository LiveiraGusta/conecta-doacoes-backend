import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestApp, type TestContext } from '../helpers/app';

describe('toda rota nasce fechada', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await buildTestApp();
  });
  afterAll(() => closeTestApp(ctx));

  const protectedRoutes = () =>
    ctx.routes
      .flatMap((r) => (Array.isArray(r.method) ? r.method : [r.method]).map((method) => ({ method, route: r })))
      .filter(({ method, route }) => method !== 'HEAD' && method !== 'OPTIONS' && !route.config?.public)
      .map(({ method, route }) => ({ method, url: route.url.replace(/:[A-Za-z]+/g, randomUUID()) }));

  it('rotas não públicas respondem 401 sem token e com token inválido', async () => {
    expect(protectedRoutes().length).toBeGreaterThanOrEqual(3); // /auth/me + 2 de /admin
    for (const { method, url } of protectedRoutes()) {
      for (const authorization of [undefined, 'Bearer token-invalido']) {
        const res = await ctx.app.inject({ method: method as 'GET', url, headers: authorization ? { authorization } : {} });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
        expect(res.json()).toMatchObject({ error: 'UNAUTHORIZED' });
      }
    }
  });

  it('token válido de usuário que não existe mais → 401', async () => {
    const token = ctx.app.jwt.sign({ sub: randomUUID(), role: 'DONOR' });
    for (const { method, url } of protectedRoutes()) {
      const res = await ctx.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('rota inexistente → 404 NOT_FOUND, não 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/nao-existe' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'NOT_FOUND', message: 'Rota não encontrada.' });
  });
});
