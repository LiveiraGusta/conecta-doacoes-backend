import type { Queryable } from '../../core/db';

export const passwordResetsRepository = {
  /** Houve pedido para este usuário nos últimos `seconds` segundos? (evita bombardear a caixa de e-mail) */
  async createdRecently(q: Queryable, userId: string, seconds: number): Promise<boolean> {
    const [row] = await q`
      SELECT 1 FROM password_resets
      WHERE user_id = ${userId} AND created_at > NOW() - make_interval(secs => ${seconds})`;
    return Boolean(row);
  },

  /** Um link válido por vez: apaga os anteriores do usuário e grava o novo. Use dentro de transação. */
  async replaceForUser(q: Queryable, userId: string, tokenHash: string, ttlMinutes: number): Promise<void> {
    await q`DELETE FROM password_resets WHERE user_id = ${userId}`;
    await q`
      INSERT INTO password_resets (user_id, token_hash, expires_at)
      VALUES (${userId}, ${tokenHash}, NOW() + make_interval(mins => ${ttlMinutes}))`;
  },

  /**
   * Consome o token numa única instrução (uso único mesmo com duas requisições simultâneas).
   * Devolve o usuário dono, ou null se o token não existe, expirou, já foi usado ou a conta foi excluída.
   */
  async consume(q: Queryable, tokenHash: string): Promise<string | null> {
    const [row] = await q<{ user_id: string }[]>`
      UPDATE password_resets pr SET used_at = NOW()
      FROM users u
      WHERE pr.token_hash = ${tokenHash}
        AND pr.used_at IS NULL
        AND pr.expires_at > NOW()
        AND u.id = pr.user_id
        AND u.deleted_at IS NULL
      RETURNING pr.user_id`;
    return row?.user_id ?? null;
  },

  /** Depois do reset, nenhum outro link do usuário continua valendo. */
  async deleteOthers(q: Queryable, userId: string, keepHash: string): Promise<void> {
    await q`DELETE FROM password_resets WHERE user_id = ${userId} AND token_hash <> ${keepHash}`;
  },
};

export type PasswordResetsRepository = typeof passwordResetsRepository;
