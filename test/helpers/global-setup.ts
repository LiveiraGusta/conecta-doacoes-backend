// Roda uma vez antes dos testes de integração/e2e: recria o schema do banco de teste e aplica as migrações.
import dotenv from 'dotenv';
import path from 'node:path';
import postgres from 'postgres';
import { runMigrations } from '../../src/core/migrator';

export default async function setup() {
  dotenv.config({ path: '.env.test', override: true, quiet: true });
  const url = process.env.DATABASE_URL;
  if (!url?.includes('_test')) throw new Error(`DATABASE_URL de teste suspeita: ${url}`);

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(sql, path.resolve('migrations'), () => {});
  } catch (err) {
    throw new Error(`Banco de teste indisponível (rode "docker compose up -d db-test"): ${String(err)}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
