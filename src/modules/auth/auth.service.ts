import { randomUUID } from 'node:crypto';
import type { Db } from '../../core/db';
import { AppError } from '../../core/errors';
import { detectFileKind, MIME } from '../../core/images';
import type { PasswordHasher } from '../../core/passwords';
import type { Storage } from '../../core/storage';
import { noopNotifier, type Notifier } from '../notifications/notifications.service';
import type { Role, UserWithProfile } from '../../types';
import type { AuthRepository } from './auth.repository';

export interface AuthDeps {
  db: Pick<Db, 'sql' | 'tx'>;
  authRepo: AuthRepository;
  storage: Storage;
  hasher: PasswordHasher;
  signToken(payload: { sub: string; role: Role }): string;
  /** E-mails de boas-vindas e de cadastro recebido. */
  notifier?: Notifier;
}

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
  city: string;
  state: string;
}

export interface RegisterNgoInput extends RegisterInput {
  cnpj: string;
  website?: string;
}

export interface AuthResult {
  token: string;
  user: UserWithProfile;
}

export const createAuthService = ({ db, authRepo, storage, hasher, signToken, notifier = noopNotifier }: AuthDeps) => {
  // Hash fixo para comparar quando o e-mail não existe: o tempo de resposta não revela contas cadastradas.
  let dummyHash: Promise<string> | undefined;
  const getDummyHash = () => (dummyHash ??= hasher.hash(randomUUID()));

  const issue = (user: UserWithProfile): AuthResult => ({ token: signToken({ sub: user.id, role: user.role }), user });

  return {
    async registerDonor(input: RegisterInput): Promise<AuthResult> {
      if (await authRepo.emailExists(db.sql, input.email)) throw new AppError('EMAIL_TAKEN');
      const password_hash = await hasher.hash(input.password);
      const user = await authRepo.insertUser(db.sql, { ...input, password_hash, role: 'DONOR' });
      notifier.notify({ type: 'donor.registered', userId: user.id });
      return issue({ ...user, ngo_profile: null });
    },

    async registerNgo(input: RegisterNgoInput, documents: Buffer[]): Promise<AuthResult> {
      if (documents.length !== 1) throw new AppError('INVALID_DOCUMENT');
      const kind = detectFileKind(documents[0]!);
      if (!kind) throw new AppError('INVALID_DOCUMENT');

      // Checagem prévia evita subir arquivo à toa; a constraint única segura a corrida.
      if (await authRepo.emailExists(db.sql, input.email)) throw new AppError('EMAIL_TAKEN');
      if (await authRepo.cnpjExists(db.sql, input.cnpj)) throw new AppError('CNPJ_TAKEN');

      const userId = randomUUID();
      const path = `${userId}/${randomUUID()}.${kind}`;
      const password_hash = await hasher.hash(input.password);

      await storage.upload('docs', path, documents[0]!, MIME[kind]);
      try {
        const user = await db.tx(async (tx) => {
          const u = await authRepo.insertUser(tx, {
            id: userId,
            name: input.name,
            email: input.email,
            password_hash,
            role: 'NGO',
            city: input.city,
            state: input.state,
          });
          const profile = await authRepo.insertNgoProfile(tx, {
            user_id: u.id,
            cnpj: input.cnpj,
            website: input.website ?? null,
            document_url: path,
          });
          return { ...u, ngo_profile: profile };
        });
        notifier.notify({ type: 'ngo.registered', userId: user.id });
        return issue(user);
      } catch (err) {
        await storage.remove('docs', [path]).catch(() => {});
        throw err;
      }
    },

    async login(email: string, password: string): Promise<AuthResult> {
      const user = await authRepo.findByEmail(db.sql, email);
      const ok = await hasher.compare(password, user?.password_hash ?? (await getDummyHash()));
      if (!user || !ok) throw new AppError('INVALID_CREDENTIALS');
      return issue(user);
    },

    async me(userId: string): Promise<UserWithProfile> {
      const user = await authRepo.findById(db.sql, userId);
      if (!user) throw new AppError('UNAUTHORIZED');
      return user;
    },
  };
};

export type AuthService = ReturnType<typeof createAuthService>;
