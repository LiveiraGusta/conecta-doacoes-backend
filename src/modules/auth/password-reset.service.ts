import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../../core/db';
import { passwordResetEmail, type Mailer } from '../../core/email';
import { AppError } from '../../core/errors';
import type { PasswordHasher } from '../../core/passwords';
import type { AuthRepository } from './auth.repository';
import type { PasswordResetsRepository } from './password-resets.repository';

export const RESET_TTL_MINUTES = 30;
/** Pedidos repetidos dentro desta janela não geram outro e-mail. */
export const RESET_COOLDOWN_SECONDS = 60;

export interface PasswordResetDeps {
  db: Pick<Db, 'sql' | 'tx'>;
  authRepo: Pick<AuthRepository, 'findByEmail' | 'setPassword'>;
  resetsRepo: PasswordResetsRepository;
  hasher: PasswordHasher;
  mailer: Mailer;
  /** URL do frontend; o link vai para APP_URL/redefinir-senha?token=… */
  appUrl: string;
  /** Falha no envio não muda a resposta (sempre 202): só é registrada. */
  onEmailError(err: unknown): void;
}

export const hashResetToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const createPasswordResetService = (deps: PasswordResetDeps) => {
  const { db, authRepo, resetsRepo, hasher, mailer } = deps;

  return {
    /**
     * Nunca revela se o e-mail existe: o resultado é o mesmo nos dois casos, e o envio
     * acontece em segundo plano para o tempo de resposta também não denunciar.
     */
    async requestReset(email: string): Promise<void> {
      const user = await authRepo.findByEmail(db.sql, email);
      if (!user) return;
      if (await resetsRepo.createdRecently(db.sql, user.id, RESET_COOLDOWN_SECONDS)) return;

      const token = randomBytes(32).toString('base64url');
      await db.tx((tx) => resetsRepo.replaceForUser(tx, user.id, hashResetToken(token), RESET_TTL_MINUTES));

      const link = new URL('/redefinir-senha', deps.appUrl);
      link.searchParams.set('token', token);
      const message = passwordResetEmail({ to: user.email, name: user.name, link: link.href, minutes: RESET_TTL_MINUTES });
      void mailer.send(message).catch(deps.onEmailError);
    },

    /** Consome o token (uso único), grava a senha nova e derruba as sessões abertas. */
    async resetPassword(token: string, newPassword: string): Promise<void> {
      const tokenHash = hashResetToken(token);
      await db.tx(async (tx) => {
        const userId = await resetsRepo.consume(tx, tokenHash);
        if (!userId) throw new AppError('INVALID_RESET_TOKEN');
        await authRepo.setPassword(tx, userId, await hasher.hash(newPassword));
        await resetsRepo.deleteOthers(tx, userId, tokenHash);
      });
    },
  };
};

export type PasswordResetService = ReturnType<typeof createPasswordResetService>;
