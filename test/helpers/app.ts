import type { FastifyInstance, RouteOptions } from 'fastify';
import { buildApp } from '../../src/app';
import { createDb, type Db } from '../../src/core/db';
import type { EmailMessage, Mailer } from '../../src/core/email';
import { fakeStorage, type FakeStorage } from './fake-storage';

export interface TestContext {
  /** O `inject` deste app já manda `x-requested-with` (anti-CSRF), como o frontend. */
  app: FastifyInstance;
  /** `inject` original, sem header nenhum: para testar a própria checagem anti-CSRF. */
  rawInject: FastifyInstance['inject'];
  db: Db;
  storage: FakeStorage;
  routes: RouteOptions[];
  /** E-mails enviados pela app (fake em memória). */
  outbox: EmailMessage[];
}

/** App completo contra o Postgres de teste, com Storage fake. Feche com `closeTestApp`. */
export async function buildTestApp(overrides: { db?: Db } = {}): Promise<TestContext> {
  const db = overrides.db ?? createDb(process.env.DATABASE_URL);
  const storage = fakeStorage();
  const routes: RouteOptions[] = [];
  const outbox: EmailMessage[] = [];
  const mailer: Mailer = { send: async (m) => void outbox.push(m) };
  const app = await buildApp({ db, storage, mailer, logger: false, onRoute: (r) => routes.push(r) });
  await app.ready();
  const rawInject = app.inject.bind(app) as FastifyInstance['inject'];
  app.inject = ((opts?: unknown, cb?: unknown) => {
    if (opts && typeof opts === 'object') {
      const o = opts as { headers?: Record<string, unknown> };
      opts = { ...o, headers: { 'x-requested-with': 'XMLHttpRequest', ...o.headers } };
    }
    return (rawInject as (...a: unknown[]) => unknown)(opts, cb);
  }) as FastifyInstance['inject'];
  return { app, rawInject, db, storage, routes, outbox };
}

export async function closeTestApp(ctx: TestContext) {
  await ctx.app.close();
  await ctx.db.close();
}

/** Limpa todas as tabelas de dados (mantém schema_migrations). */
export async function resetDb(db: Db) {
  await db.sql.unsafe(`
    TRUNCATE users, ngo_profiles, items, item_photos, item_interests, chat_messages, item_events, reports,
      password_resets, chat_reads
    RESTART IDENTITY CASCADE`);
}
