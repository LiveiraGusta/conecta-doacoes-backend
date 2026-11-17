import type { FastifyInstance, RouteOptions } from 'fastify';
import { buildApp } from '../../src/app';
import { createDb, type Db } from '../../src/core/db';
import { fakeStorage, type FakeStorage } from './fake-storage';

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  storage: FakeStorage;
  routes: RouteOptions[];
}

/** App completo contra o Postgres de teste, com Storage fake. Feche com `closeTestApp`. */
export async function buildTestApp(overrides: { db?: Db } = {}): Promise<TestContext> {
  const db = overrides.db ?? createDb(process.env.DATABASE_URL);
  const storage = fakeStorage();
  const routes: RouteOptions[] = [];
  const app = await buildApp({ db, storage, logger: false, onRoute: (r) => routes.push(r) });
  await app.ready();
  return { app, db, storage, routes };
}

export async function closeTestApp(ctx: TestContext) {
  await ctx.app.close();
  await ctx.db.close();
}

/** Limpa todas as tabelas de dados (mantém schema_migrations). */
export async function resetDb(db: Db) {
  await db.sql.unsafe(`
    TRUNCATE users, ngo_profiles, items, item_photos, item_interests, chat_messages, item_events, reports
    RESTART IDENTITY CASCADE`);
}
