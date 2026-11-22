import { z } from 'zod';
import {
  Category,
  isoDate,
  ItemStatus,
  optionalText,
  PaginationQuery,
  text,
  toIso,
  toIsoOrNull,
  UF,
} from '../../core/dto';
import type { Item, ItemPhoto, ItemView } from '../../types';

// ── Entrada ──
/** Campos de texto do multipart de POST /items (as 3 fotos vêm no campo `photos`). */
export const PublishItemFields = z
  .object({
    title: text(3, 255),
    description: optionalText(2000),
    notes: optionalText(1000),
    category: Category,
    city: optionalText(100).pipe(z.string().min(2).optional()),
    state: z.preprocess((v) => (v === '' ? undefined : v), UF.optional()),
  })
  .superRefine((v, ctx) => {
    // A localização do item é a do doador, a menos que venham cidade e UF juntas.
    if (Boolean(v.city) !== Boolean(v.state)) {
      ctx.addIssue({ code: 'custom', path: [v.city ? 'state' : 'city'], message: 'Informe cidade e UF juntas' });
    }
  });
export type PublishItemFields = z.infer<typeof PublishItemFields>;

export const FeedQuery = PaginationQuery.extend({
  category: Category.optional(),
  search: optionalText(100),
});
export type FeedQuery = z.infer<typeof FeedQuery>;

export const MyItemsQuery = PaginationQuery.extend({
  status: ItemStatus.optional(),
});
export type MyItemsQuery = z.infer<typeof MyItemsQuery>;

// ── Saída ──
export const ModerationStatus = z.enum(['VISIVEL', 'OCULTO', 'REMOVIDO']);

/** Moderação do anúncio. O motivo só vem para o doador (null para os demais). */
const moderationFields = {
  moderation_status: ModerationStatus,
  moderation_reason: z.string().nullable(),
};

export const PhotoDto = z.object({ id: z.uuid(), photo_url: z.string() }).describe('Photo');

export const ItemDto = z
  .object({
    id: z.uuid(),
    donor_id: z.uuid(),
    title: z.string(),
    description: z.string().nullable(),
    notes: z.string().nullable(),
    category: Category,
    city: z.string(),
    state: z.string(),
    status: ItemStatus,
    selected_ngo_id: z.uuid().nullable(),
    photos: z.array(PhotoDto),
    created_at: isoDate(),
    completed_at: isoDate().nullable(),
    ...moderationFields,
  })
  .describe('Item');
export type ItemDto = z.infer<typeof ItemDto>;

export const DonorDto = z
  .object({ id: z.uuid(), name: z.string(), avatar_url: z.string().nullable() })
  .describe('Donor');

export const FeedItemDto = z
  .object({
    id: z.uuid(),
    title: z.string(),
    description: z.string().nullable(),
    category: Category,
    city: z.string(),
    state: z.string(),
    status: ItemStatus,
    has_user_interest: z.boolean(),
    interests_count: z.number().int().min(0),
    is_selected: z.boolean(),
    created_at: isoDate(),
    donor: DonorDto,
    photos: z.array(z.string()),
    ...moderationFields,
  })
  .describe('FeedItem');
export type FeedItemDto = z.infer<typeof FeedItemDto>;

export const ItemListDto = z
  .object({ total: z.number().int().min(0), data: z.array(FeedItemDto) })
  .describe('ItemList');
export type ItemListDto = z.infer<typeof ItemListDto>;

export const ItemDetailDto = ItemDto.extend({
  donor: DonorDto,
  has_user_interest: z.boolean(),
  interests_count: z.number().int().min(0),
  is_selected: z.boolean(),
}).describe('ItemDetail');
export type ItemDetailDto = z.infer<typeof ItemDetailDto>;

// ── Mapeamento ──
/** "Marina Souza" → "Marina S."; nome único fica como está. */
export function abbreviateName(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

/** Contexto calculado pelo service para quem está vendo o item. */
export interface ViewerContext {
  has_user_interest: boolean;
  is_selected: boolean;
}

const baseItem = (item: Item, photos: { id: string; photo_url: string }[]) => ({
  id: item.id,
  donor_id: item.donor_id,
  title: item.title,
  description: item.description,
  notes: item.notes,
  category: item.category,
  city: item.city,
  state: item.state,
  status: item.status,
  selected_ngo_id: item.selected_ngo_id,
  photos,
  created_at: toIso(item.created_at),
  completed_at: toIsoOrNull(item.completed_at),
  moderation_status: item.moderation_status,
  moderation_reason: item.moderation_reason,
});

export const toItemDto = (item: Item & { photos: ItemPhoto[] }): ItemDto =>
  baseItem(
    item,
    item.photos.map((p) => ({ id: p.id, photo_url: p.photo_url })),
  );

export const toFeedItemDto = (v: ItemView & ViewerContext): FeedItemDto => ({
  id: v.id,
  title: v.title,
  description: v.description,
  category: v.category,
  city: v.city,
  state: v.state,
  status: v.status,
  has_user_interest: v.has_user_interest,
  interests_count: v.interests_count,
  is_selected: v.is_selected,
  created_at: toIso(v.created_at),
  donor: { id: v.donor_id, name: abbreviateName(v.donor_name), avatar_url: v.donor_avatar_url ?? null },
  photos: v.photos,
  moderation_status: v.moderation_status,
  moderation_reason: v.moderation_reason,
});

export const toItemListDto = (page: { total: number; rows: (ItemView & ViewerContext)[] }): ItemListDto => ({
  total: page.total,
  data: page.rows.map(toFeedItemDto),
});

export const toItemDetailDto = (v: ItemView & ViewerContext): ItemDetailDto => ({
  ...baseItem(
    v,
    v.photo_ids.map((id, i) => ({ id, photo_url: v.photos[i]! })),
  ),
  donor: { id: v.donor_id, name: abbreviateName(v.donor_name), avatar_url: v.donor_avatar_url ?? null },
  has_user_interest: v.has_user_interest,
  interests_count: v.interests_count,
  is_selected: v.is_selected,
});

// ── Visitante (rotas /public/items) ──
/** Item para quem não está logado: sem doador, sem observações e sem contagem de interessadas. */
export const PublicItemDto = z
  .object({
    id: z.uuid(),
    title: z.string(),
    description: z.string().nullable(),
    category: Category,
    city: z.string(),
    state: z.string(),
    status: z.enum(['DISPONIVEL', 'EM_PROGRESSO']),
    created_at: isoDate(),
    /** URLs das 3 fotos, na ordem de envio (a primeira é a capa). */
    photos: z.array(z.string()),
  })
  .strict()
  .describe('PublicItem');
export type PublicItemDto = z.infer<typeof PublicItemDto>;

export const PublicItemListDto = z
  .object({ total: z.number().int().min(0), data: z.array(PublicItemDto) })
  .strict()
  .describe('PublicItemList');
export type PublicItemListDto = z.infer<typeof PublicItemListDto>;

export const PublicFeedQuery = FeedQuery;
export type PublicFeedQuery = z.infer<typeof PublicFeedQuery>;

export const toPublicItemDto = (v: ItemView): PublicItemDto => ({
  id: v.id,
  title: v.title,
  description: v.description,
  category: v.category,
  city: v.city,
  state: v.state,
  status: v.status as PublicItemDto['status'],
  created_at: toIso(v.created_at),
  photos: v.photos,
});

export const toPublicItemListDto = (page: { total: number; rows: ItemView[] }): PublicItemListDto => ({
  total: page.total,
  data: page.rows.map(toPublicItemDto),
});
