// npm run migrate — aplica as migrações pendentes em DATABASE_URL.
// Lê só DATABASE_URL, para rodar antes do start em produção sem depender do resto do env.
import 'dotenv/config';
import path from 'node:path';
import postgres from 'postgres';
import { runMigrations } from '../src/core/migrator';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL não definida.');
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  await runMigrations(sql, path.resolve(process.cwd(), 'migrations'));
} catch (err) {
  console.error('Falha na migração:', err);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
