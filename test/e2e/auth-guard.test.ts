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

  it('rotas não públicas respondem 401 sem cookie, com cookie inválido e com Bearer', async () => {
    expect(protectedRoutes().length).toBeGreaterThanOrEqual(3); // /auth/me + 2 de /admin
    const valid = ctx.app.jwt.sign({ sub: randomUUID(), role: 'DONOR' });
    const variants: Record<string, string>[] = [{}, { cookie: 'cd_session=token-invalido' }, { authorization: `Bearer ${valid}` }];
    for (const { method, url } of protectedRoutes()) {
      for (const headers of variants) {
        const res = await ctx.app.inject({ method: method as 'GET', url, headers });
        expect(res.statusCode, `${method} ${url} ${JSON.stringify(headers)}`).toBe(401);
        expect(res.json()).toMatchObject({ error: 'UNAUTHORIZED' });
      }
    }
  });

  it('cookie válido de usuário que não existe mais → 401', async () => {
    const token = ctx.app.jwt.sign({ sub: randomUUID(), role: 'DONOR' });
    for (const { method, url } of protectedRoutes()) {
      const res = await ctx.app.inject({ method: method as 'GET', url, headers: { cookie: `cd_session=${token}` } });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('a lista de rotas públicas é exatamente esta (um `public: true` acidental quebra o teste)', () => {
    const publicRoutes = ctx.routes
      .filter((r) => r.config?.public)
      .flatMap((r) => (Array.isArray(r.method) ? r.method : [r.method]).filter((m) => m !== 'HEAD').map((m) => `${m} ${r.url}`))
      .sort();
    expect(publicRoutes).toEqual(
      [
        'GET /api/v1/chats/ws',
        'GET /health',
        'GET /health/ready',
        'POST /api/v1/auth/login',
        'POST /api/v1/auth/logout',
        'POST /api/v1/auth/password/forgot',
        'POST /api/v1/auth/password/reset',
        'POST /api/v1/auth/register/donor',
        'POST /api/v1/auth/register/ngo',
        'GET /api/v1/public/items',
        'GET /api/v1/public/items/:itemId',
        'GET /api/v1/public/users/:userId',
      ].sort(),
    );
  });

  it('rota inexistente → 404 NOT_FOUND, não 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/nao-existe' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'NOT_FOUND', message: 'Rota não encontrada.' });
  });
});
