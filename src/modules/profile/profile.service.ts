import { randomUUID } from 'node:crypto';
import type { Db } from '../../core/db';
import { AppError } from '../../core/errors';
import { detectFileKind, MIME, toProfileWebp, type ProfileImageKind } from '../../core/images';
import type { PasswordHasher } from '../../core/passwords';
import type { Storage } from '../../core/storage';
import type { AuthUser, Category, UserPreferences, UserWithProfile } from '../../types';
import { DEFAULT_PREFERENCES } from '../auth/auth.dto';
import type { AuthRepository } from '../auth/auth.repository';
import { noopNotifier, type Notifier } from '../notifications/notifications.service';
import { NGO_ONLY_FIELDS, type AddressBody } from './profile.dto';
import type { NgoProfilePatch, ProfileRepository } from './profile.repository';

export interface ProfileDeps {
  db: Pick<Db, 'sql' | 'tx'>;
  profileRepo: ProfileRepository;
  authRepo: Pick<AuthRepository, 'findById' | 'setPassword'>;
  storage: Storage;
  hasher: PasswordHasher;
  /** Senha alterada, documento reenviado (para os administradores) e conta excluída. */
  notifier?: Notifier;
}

export interface ProfilePatch {
  name?: string;
  city?: string;
  state?: string;
  bio?: string | null;
  website?: string | null;
  phone?: string | null;
  instagram?: string | null;
  accepted_categories?: Category[];
  address?: AddressBody;
}

/** Endereço null apaga as 5 colunas; objeto grava todas (complemento ausente vira null). */
const addressColumns = (address: AddressBody | undefined): NgoProfilePatch => {
  if (address === undefined) return {};
  if (address === null) return { cep: null, street: null, number: null, complement: null, neighborhood: null };
  return { ...address, complement: address.complement ?? null };
};

export const createProfileService = ({ db, profileRepo, authRepo, storage, hasher, notifier = noopNotifier }: ProfileDeps) => {
  async function loadSelf(userId: string): Promise<UserWithProfile> {
    const user = await authRepo.findById(db.sql, userId);
    if (!user) throw new AppError('UNAUTHORIZED');
    return user;
  }

  async function checkPassword(user: UserWithProfile, password: string) {
    if (!(await hasher.compare(password, user.password_hash))) throw new AppError('INVALID_CURRENT_PASSWORD');
  }

  /** Remove do bucket público um arquivo pela URL; falha só vai para o vazio (o banco já está certo). */
  const removePublic = async (url: string | null | undefined) => {
    const path = url ? storage.pathFromPublicUrl(url) : null;
    if (path) await storage.remove('items', [path]).catch(() => {});
  };

  /**
   * Sobe a imagem nova, grava a URL e só então apaga a antiga. Se gravar falhar, a nova é apagada.
   * Avatar: doador e ONG. Banner: só ONG (a rota já barra os outros perfis).
   */
  async function replaceProfileImage(user: AuthUser, kind: ProfileImageKind, files: Buffer[]): Promise<UserWithProfile> {
    if (files.length !== 1) throw new AppError('INVALID_PHOTO');
    const webp = await toProfileWebp(files[0]!, kind);
    const path = `profiles/${user.id}/${kind}-${randomUUID()}.webp`;
    await storage.upload('items', path, webp, 'image/webp');
    const url = storage.publicUrl(path);

    let old: string | null;
    try {
      old =
        kind === 'avatar'
          ? await profileRepo.setAvatarUrl(db.sql, user.id, url)
          : await profileRepo.setBannerUrl(db.sql, user.id, url);
    } catch (err) {
      await storage.remove('items', [path]).catch(() => {});
      throw err;
    }
    await removePublic(old);
    return loadSelf(user.id);
  }

  async function clearProfileImage(user: AuthUser, kind: ProfileImageKind): Promise<UserWithProfile> {
    const old =
      kind === 'avatar'
        ? await profileRepo.setAvatarUrl(db.sql, user.id, null)
        : await profileRepo.setBannerUrl(db.sql, user.id, null);
    await removePublic(old);
    return loadSelf(user.id);
  }

  return {
    setAvatar: (user: AuthUser, files: Buffer[]) => replaceProfileImage(user, 'avatar', files),
    removeAvatar: (user: AuthUser) => clearProfileImage(user, 'avatar'),
    setBanner: (user: AuthUser, files: Buffer[]) => replaceProfileImage(user, 'banner', files),
    removeBanner: (user: AuthUser) => clearProfileImage(user, 'banner'),

    /**
     * Nome, cidade/UF e descrição; a ONG também edita site, contato, categorias aceitas e endereço.
     * Mudar a cidade muda o feed na hora; os itens já publicados não mudam.
     */
    async update(user: AuthUser, patch: ProfilePatch): Promise<UserWithProfile> {
      if (user.role !== 'NGO') {
        const details = NGO_ONLY_FIELDS.filter((f) => patch[f] !== undefined).map((path) => ({
          path,
          message: 'Campo disponível só para ONGs',
        }));
        if (details.length) throw new AppError('VALIDATION_ERROR', undefined, details);
      }
      await db.tx(async (tx) => {
        const { name, city, state, bio, website, phone, instagram, accepted_categories, address } = patch;
        if ([name, city, state].some((v) => v !== undefined)) await profileRepo.updateUser(tx, user.id, { name, city, state });
        if (bio !== undefined) await profileRepo.updateBio(tx, user.id, bio);
        if (website !== undefined) await profileRepo.updateWebsite(tx, user.id, website);
        if (user.role === 'NGO') {
          await profileRepo.updateNgoProfile(tx, user.id, { phone, instagram, accepted_categories, ...addressColumns(address) });
        }
      });
      return loadSelf(user.id);
    },

    async getPreferences(user: AuthUser): Promise<UserPreferences> {
      return (await loadSelf(user.id)).preferences ?? DEFAULT_PREFERENCES;
    },

    /** Mescla o que veio com o que está gravado (ou os padrões). `show_donations` é só do doador. */
    async updatePreferences(user: AuthUser, patch: Partial<UserPreferences>): Promise<UserPreferences> {
      if (patch.show_donations !== undefined && user.role !== 'DONOR') {
        throw new AppError('VALIDATION_ERROR', undefined, [
          { path: 'show_donations', message: 'Só doadores escolhem mostrar as doações na página pessoal' },
        ]);
      }
      const current = (await loadSelf(user.id)).preferences ?? DEFAULT_PREFERENCES;
      const next: UserPreferences = {
        theme_color: patch.theme_color ?? current.theme_color,
        theme_mode: patch.theme_mode ?? current.theme_mode,
        show_donations: patch.show_donations ?? current.show_donations,
      };
      return profileRepo.upsertPreferences(db.sql, user.id, next);
    },

    /** Troca a senha e invalida os tokens emitidos antes (o controller reemite o cookie desta sessão). */
    async changePassword(user: AuthUser, current: string, next: string): Promise<void> {
      const self = await loadSelf(user.id);
      await checkPassword(self, current);
      if (await hasher.compare(next, self.password_hash)) throw new AppError('SAME_PASSWORD');
      await authRepo.setPassword(db.sql, user.id, await hasher.hash(next));
      notifier.notify({ type: 'password.changed', userId: user.id });
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
      notifier.notify({ type: 'ngo.document_resubmitted', userId: ngo.id });
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
      // O e-mail real some na anonimização: vai junto no evento.
      notifier.notify({ type: 'account.deleted', email: self.email, name: self.name });

      // Arquivos saem depois do commit; falha aqui não desfaz a exclusão.
      // A foto de perfil e o banner saem junto: a conta anonimizada não guarda imagem da pessoa.
      const profileImages = [self.avatar_url, self.ngo_profile?.banner_url].filter((u): u is string => Boolean(u));
      const photoPaths = [...photoUrls, ...profileImages]
        .map((u) => storage.pathFromPublicUrl(u))
        .filter((p): p is string => Boolean(p));
      await storage.remove('items', photoPaths).catch(() => {});
      if (documentPath) await storage.remove('docs', [documentPath]).catch(() => {});
    },
  };
};

export type ProfileService = ReturnType<typeof createProfileService>;
