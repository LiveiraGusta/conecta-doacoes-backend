import { randomUUID } from 'node:crypto';
import type { Db } from '../../core/db';
import { AppError } from '../../core/errors';
import { toWebp } from '../../core/images';
import type { Storage } from '../../core/storage';
import type { AuthUser, Category, Item, ItemPhoto, ItemStatus } from '../../types';
import type { ItemEventsRepository } from './item-events.repository';
import type { ItemsRepository, ItemView, Page } from './items.repository';

export interface ItemsDeps {
  db: Pick<Db, 'sql' | 'tx'>;
  itemsRepo: ItemsRepository;
  eventsRepo: ItemEventsRepository;
  storage: Storage;
}

export interface PublishInput {
  title: string;
  description?: string;
  notes?: string;
  category: Category;
  city?: string;
  state?: string;
}

export type ViewedItem = ItemView & { is_selected: boolean };

const REQUIRED_PHOTOS = 3;

/** Visitante não tem id: a coluna has_user_interest compara com um UUID que nunca existe. */
const NO_VIEWER = '00000000-0000-0000-0000-000000000000';

export const createItemsService = ({ db, itemsRepo, eventsRepo, storage }: ItemsDeps) => {
  /**
   * Contexto de quem está vendo: ONG não ativa não vê "já curti" (o frontend esconde o botão).
   * O motivo da remoção pela moderação é só do doador.
   */
  const withViewer = (viewer: AuthUser) => (v: ItemView): ViewedItem => ({
    ...v,
    moderation_reason: viewer.id === v.donor_id ? v.moderation_reason : null,
    has_user_interest: viewer.role === 'NGO' && viewer.ngoStatus === 'ATIVO' ? v.has_user_interest : false,
    is_selected: viewer.role === 'NGO' && v.selected_ngo_id === viewer.id,
  });

  const mapPage = (viewer: AuthUser, page: Page<ItemView>): Page<ViewedItem> => ({
    total: page.total,
    rows: page.rows.map(withViewer(viewer)),
  });

  return {
    /**
     * Publica um item com exatamente 3 fotos.
     * Fluxo: valida e converte as fotos → sobe as 3 em paralelo → transação (item + fotos + evento)
     * → se algo falhar depois do upload, apaga as fotos do Storage.
     */
    async publish(donor: AuthUser, input: PublishInput, photos: Buffer[]): Promise<Item & { photos: ItemPhoto[] }> {
      if (photos.length !== REQUIRED_PHOTOS) throw new AppError('INVALID_PHOTO_COUNT');
      const webps = await Promise.all(photos.map((p) => toWebp(p)));

      const itemId = randomUUID();
      const paths = webps.map(() => `${itemId}/${randomUUID()}.webp`);

      const uploads = await Promise.allSettled(paths.map((path, i) => storage.upload('items', path, webps[i]!, 'image/webp')));
      const failed = uploads.find((u): u is PromiseRejectedResult => u.status === 'rejected');
      if (failed) {
        const uploaded = paths.filter((_, i) => uploads[i]!.status === 'fulfilled');
        await storage.remove('items', uploaded).catch(() => {});
        throw failed.reason;
      }

      try {
        return await db.tx(async (tx) => {
          const item = await itemsRepo.insertWithPhotos(
            tx,
            {
              id: itemId,
              donor_id: donor.id,
              title: input.title,
              description: input.description ?? null,
              notes: input.notes ?? null,
              category: input.category,
              city: input.city ?? donor.city,
              state: input.state ?? donor.state,
            },
            paths.map((p) => storage.publicUrl(p)),
          );
          await eventsRepo.insert(tx, { itemId, from: null, to: 'DISPONIVEL', actorId: donor.id });
          return item;
        });
      } catch (err) {
        await storage.remove('items', paths).catch(() => {});
        throw err;
      }
    },

    async feed(
      viewer: AuthUser,
      f: { category?: Category; search?: string; limit: number; offset: number },
    ): Promise<Page<ViewedItem>> {
      const page = await itemsRepo.findFeed(db.sql, {
        ...f,
        city: viewer.city,
        state: viewer.state,
        viewerId: viewer.id,
      });
      return mapPage(viewer, page);
    },

    /** DONOR: as próprias doações. NGO: os itens que curtiu. */
    async mine(viewer: AuthUser, f: { status?: ItemStatus; limit: number; offset: number }): Promise<Page<ViewedItem>> {
      const page =
        viewer.role === 'DONOR'
          ? await itemsRepo.findByDonor(db.sql, { donorId: viewer.id, ...f })
          : await itemsRepo.findInterestedBy(db.sql, { ngoId: viewer.id, ...f });
      return mapPage(viewer, page);
    },

    /** Anúncio oculto ou removido pela moderação só aparece para o doador, a ONG escolhida e o Admin. */
    async detail(viewer: AuthUser, itemId: string): Promise<ViewedItem> {
      const view = await itemsRepo.findView(db.sql, itemId, viewer.id);
      if (!view) throw new AppError('ITEM_NOT_FOUND');
      const insider = viewer.role === 'ADMIN' || viewer.id === view.donor_id || viewer.id === view.selected_ngo_id;
      if (view.moderation_status !== 'VISIVEL' && !insider) throw new AppError('ITEM_NOT_FOUND');
      return withViewer(viewer)(view);
    },

    /** Doações concluídas pelo doador (página pessoal). */
    async donatedBy(viewer: AuthUser, donorId: string, page: { limit: number; offset: number }): Promise<Page<ViewedItem>> {
      return mapPage(viewer, await itemsRepo.findDonated(db.sql, { donorId, viewerId: viewer.id, ...page }));
    },

    /** Itens recebidos pela ONG (página pessoal). */
    async receivedBy(viewer: AuthUser, ngoId: string, page: { limit: number; offset: number }): Promise<Page<ViewedItem>> {
      return mapPage(viewer, await itemsRepo.findDonated(db.sql, { ngoId, viewerId: viewer.id, ...page }));
    },

    /** Visitante: feed de todas as cidades. */
    publicFeed(f: { category?: Category; search?: string; limit: number; offset: number }): Promise<Page<ItemView>> {
      return itemsRepo.findFeed(db.sql, { ...f, viewerId: NO_VIEWER });
    },

    /** Visitante: só itens que estão no feed (DISPONIVEL ou EM_PROGRESSO, e VISIVEL); o resto é 404. */
    async publicDetail(itemId: string): Promise<ItemView> {
      const view = await itemsRepo.findView(db.sql, itemId, NO_VIEWER);
      const inFeed = view && (view.status === 'DISPONIVEL' || view.status === 'EM_PROGRESSO');
      if (!view || !inFeed || view.moderation_status !== 'VISIVEL') throw new AppError('ITEM_NOT_FOUND');
      return view;
    },
  };
};

export type ItemsService = ReturnType<typeof createItemsService>;
