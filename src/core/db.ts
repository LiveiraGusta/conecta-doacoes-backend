import postgres from 'postgres';
import { env } from './env';

export type Sql = postgres.Sql;
/** O pool ou uma transação: todo método de repository recebe isto como primeiro argumento. */
export type Queryable = postgres.Sql | postgres.TransactionSql;

export interface Db {
  sql: Sql;
  tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** SELECT 1 com timeout; devolve a latência em ms ou lança. */
  ping(timeoutMs: number): Promise<number>;
  close(): Promise<void>;
}

export function createDb(url: string = env.DATABASE_URL): Db {
  const sql = postgres(url, {
    max: env.DATABASE_POOL_MAX,
    prepare: false, // pooler do Supabase (porta 6543) em modo transaction não suporta prepared statements
    onnotice: () => {},
  });

  return {
    sql,
    tx: <T>(fn: (tx: Queryable) => Promise<T>) => sql.begin((tx) => fn(tx)) as Promise<T>,
    async ping(timeoutMs) {
      const start = Date.now();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      });
      try {
        await Promise.race([sql`SELECT 1`, timeout]);
      } finally {
        clearTimeout(timer);
      }
      return Date.now() - start;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}
