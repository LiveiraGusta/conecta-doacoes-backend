import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type postgres from 'postgres';

const MIGRATION_LOCK_ID = 727_001; // pg_advisory_lock: impede duas instâncias migrando ao mesmo tempo

/** Aplica, em ordem, os arquivos NNN_*.sql ainda não registrados em schema_migrations. */
export async function runMigrations(sql: postgres.Sql, dir: string, log: (msg: string) => void = console.log) {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`;
    const applied = new Set((await tx<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

    const pending = files.filter((f) => !applied.has(f));
    if (pending.length === 0) log('Nenhuma migração pendente.');

    for (const file of pending) {
      const content = await readFile(path.join(dir, file), 'utf8');
      await tx.unsafe(content);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      log(`Aplicada: ${file}`);
    }
  });
}
