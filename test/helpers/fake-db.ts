import type { Db, Queryable } from '../../src/core/db';

/** Db para testes unitários de service: tx(fn) chama fn direto, sem banco. */
export const fakeDb = (): Pick<Db, 'sql' | 'tx'> => ({
  sql: {} as Db['sql'],
  tx: async (fn) => fn({} as Queryable),
});
