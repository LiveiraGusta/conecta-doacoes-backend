import { randomUUID } from 'node:crypto';
import type { Db } from '../../core/db';
import { AppError } from '../../core/errors';
import { detectFileKind, MIME } from '../../core/images';
import type { PasswordHasher } from '../../core/passwords';
import type { Storage } from '../../core/storage';
import type { AuthUser, UserWithProfile } from '../../types';
import type { AuthRepository } from '../auth/auth.repository';
import type { ProfileRepository } from './profile.repository';

export interface ProfileDeps {
  db: Pick<Db, 'sql' | 'tx'>;
  profileRepo: ProfileRepository;
  authRepo: Pick<AuthRepository, 'findById' | 'setPassword'>;
  storage: Storage;
  hasher: PasswordHasher;
}

export interface ProfilePatch {
  name?: string;
  city?: string;
  state?: string;
  website?: string | null;
}

export const createProfileService = ({ db, profileRepo, authRepo, storage, hasher }: ProfileDeps) => {
  async function loadSelf(userId: string): Promise<UserWithProfile> {
    const user = await authRepo.findById(db.sql, userId);
    if (!user) throw new AppError('UNAUTHORIZED');
    return user;
  }

  async function checkPassword(user: UserWithProfile, password: string) {
    if (!(await hasher.compare(password, user.password_hash))) throw new AppError('INVALID_CURRENT_PASSWORD');
  }

  return {
    /** Nome, cidade/UF e (ONG) site. Mudar a cidade muda o feed na hora; os itens já publicados não mudam. */
    async update(user: AuthUser, patch: ProfilePatch): Promise<UserWithProfile> {
      if (patch.website !== undefined && user.role !== 'NGO') {
        throw new AppError('VALIDATION_ERROR', undefined, [{ path: 'website', message: 'Só ONGs têm site no perfil' }]);
      }
      await db.tx(async (tx) => {
        const { website, ...fields } = patch;
        if (Object.values(fields).some((v) => v !== undefined)) await profileRepo.updateUser(tx, user.id, fields);
        if (website !== undefined) await profileRepo.updateWebsite(tx, user.id, website);
      });
      return loadSelf(user.id);
    },

    /** Troca a senha e invalida os tokens emitidos antes (o frontend faz login de novo). */
    async changePassword(user: AuthUser, current: string, next: string): Promise<void> {
      const self = await loadSelf(user.id);
      await checkPassword(self, current);
      if (await hasher.compare(next, self.password_hash)) throw new AppError('SAME_PASSWORD');
      await authRepo.setPassword(db.sql, user.id, await hasher.hash(next));
    },

    /** ONG pendente ou rejeitada reenvia o documento e volta para a fila de análise. */
    async resubmitDocument(ngo: AuthUser, documents: Buffer[]): Promise<UserWithProfile> {
      if (documents.length !== 1) throw new AppError('INVALID_DOCUMENT');
      const kind = detectFileKind(documents[0]!);
      if (!kind) throw new AppError('INVALID_DOCUMENT');
      if (ngo.ngoStatus === 'ATIVO') throw new AppError('NGO_ALREADY_ACTIVE');

      const path = `${ngo.id}/${randomUUID()}.${kind}`;
      await storage.upload('docs', path, documents[0]!, MIME[kind]);

      let oldPath: string;
      try {
        const result = await db.tx((tx) => profileRepo.replaceDocumentUnlessActive(tx, ngo.id, path));
        if (!result.replaced) throw new AppError(result.isActive ? 'NGO_ALREADY_ACTIVE' : 'FORBIDDEN');
        oldPath = result.oldPath;
      } catch (err) {
        await storage.remove('docs', [path]).catch(() => {});
        throw err;
      }
      await storage.remove('docs', [oldPath]).catch(() => {}); // o antigo sai só depois do commit
      return loadSelf(ngo.id);
    },

    /**
     * Exclusão por anonimização. Bloqueada com negociação em andamento.
     * Doador: itens DISPONIVEL saem de vez (com as fotos). ONG: curtidas abertas e documento saem,
     * e o perfil é removido (libera o CNPJ). Itens DOADO e conversas ficam para o histórico.
     */
    async deleteAccount(user: AuthUser, password: string): Promise<void> {
      const self = await loadSelf(user.id);
      await checkPassword(self, password);
      if (await profileRepo.hasActiveNegotiations(db.sql, user.id)) throw new AppError('HAS_ACTIVE_NEGOTIATIONS');

      const { photoUrls, documentPath } = await db.tx(async (tx) => {
        let urls: string[] = [];
        let doc: string | null = null;
        if (user.role === 'DONOR') urls = await profileRepo.deleteAvailableItemsOfDonor(tx, user.id);
        if (user.role === 'NGO') {
          await profileRepo.deleteOpenInterestsOfNgo(tx, user.id);
          doc = await profileRepo.deleteNgoProfile(tx, user.id);
        }
        await profileRepo.anonymize(tx, user.id);
        return { photoUrls: urls, documentPath: doc };
      });

      // Arquivos saem depois do commit; falha aqui não desfaz a exclusão.
      const photoPaths = photoUrls.map((u) => storage.pathFromPublicUrl(u)).filter((p): p is string => Boolean(p));
      await storage.remove('items', photoPaths).catch(() => {});
      if (documentPath) await storage.remove('docs', [documentPath]).catch(() => {});
    },
  };
};

export type ProfileService = ReturnType<typeof createProfileService>;
