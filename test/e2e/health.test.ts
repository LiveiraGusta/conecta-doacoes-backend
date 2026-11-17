import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/core/db';
import { buildTestApp, closeTestApp, type TestContext } from '../helpers/app';
import { expectContract } from '../helpers/contract';

describe('health', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await buildTestApp();
  });
  afterAll(() => closeTestApp(ctx));

  it('GET /health responde 200 sem token', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', version: '1.0.0' });
    await expectContract(res, 'GET', '/health');
  });

  it('GET /health/ready responde 200 com o banco de pé', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.database.status).toBe('ok');
    await expectContract(res, 'GET', '/health/ready');
  });

  it('GET /health/ready responde 503 sem detalhes do driver quando o banco não responde', async () => {
    const db = createDb(process.env.DATABASE_URL);
    const down = await buildTestApp({
      db: { ...db, ping: async () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1:5432')) },
    });
    try {
      const res = await down.app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json().checks.database).toEqual({ status: 'error', error: 'unavailable' });
      expect(res.body).not.toContain('ECONNREFUSED');
      await expectContract(res, 'GET', '/health/ready');
    } finally {
      await closeTestApp(down);
    }
  });
});
