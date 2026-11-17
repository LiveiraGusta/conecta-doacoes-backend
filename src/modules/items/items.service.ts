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
  category: Category;
  city?: string;
  state?: string;
}

export type ViewedItem = ItemView & { is_selected: boolean };

const REQUIRED_PHOTOS = 3;

export const createItemsService = ({ db, itemsRepo, eventsRepo, storage }: ItemsDeps) => {
  /** Contexto de quem está vendo: ONG não ativa não vê "já curti" (o frontend esconde o botão). */
  const withViewer = (viewer: AuthUser) => (v: ItemView): ViewedItem => ({
    ...v,
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

    async detail(viewer: AuthUser, itemId: string): Promise<ViewedItem> {
      const view = await itemsRepo.findView(db.sql, itemId, viewer.id);
      if (!view) throw new AppError('ITEM_NOT_FOUND');
      return withViewer(viewer)(view);
    },
  };
};

export type ItemsService = ReturnType<typeof createItemsService>;
