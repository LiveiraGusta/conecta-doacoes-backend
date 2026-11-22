import { z } from 'zod';
import { isoDate, NgoStatus, toIso } from '../../core/dto';
import type { InterestedNgo, Item, ItemInterest } from '../../types';

// ── Entrada ──
export const SelectNgoBody = z.object({ ngo_id: z.uuid() });
export type SelectNgoBody = z.infer<typeof SelectNgoBody>;

// ── Saída ──
export const InterestDto = z
  .object({ id: z.uuid(), item_id: z.uuid(), ngo_id: z.uuid(), created_at: isoDate() })
  .describe('Interest');
export type InterestDto = z.infer<typeof InterestDto>;

export const InterestedNgoDto = z
  .object({
    interest_id: z.uuid(),
    ngo_id: z.uuid(),
    name: z.string(),
    avatar_url: z.string().nullable(),
    city: z.string(),
    state: z.string(),
    cnpj: z.string(),
    website: z.string().nullable(),
    ngo_status: NgoStatus,
    liked_at: isoDate(),
  })
  .describe('InterestedNgo');

export const InterestListDto = z
  .object({ item_id: z.uuid(), total: z.number().int().min(0), interested_ngos: z.array(InterestedNgoDto) })
  .describe('InterestList');
export type InterestListDto = z.infer<typeof InterestListDto>;

export const SelectionDto = z
  .object({
    item_id: z.uuid(),
    status: z.literal('EM_PROGRESSO'),
    selected_ngo_id: z.uuid(),
    chat_room_url: z.string(),
  })
  .describe('Selection');
export type SelectionDto = z.infer<typeof SelectionDto>;

// ── Mapeamento ──
export const toInterestDto = (i: ItemInterest): InterestDto => ({
  id: i.id,
  item_id: i.item_id,
  ngo_id: i.ngo_id,
  created_at: toIso(i.created_at),
});

export const toInterestListDto = (itemId: string, rows: InterestedNgo[]): InterestListDto => ({
  item_id: itemId,
  total: rows.length,
  interested_ngos: rows.map((r) => ({ ...r, liked_at: toIso(r.liked_at) })),
});

export const toSelectionDto = (item: Item): SelectionDto => ({
  item_id: item.id,
  status: 'EM_PROGRESSO',
  selected_ngo_id: item.selected_ngo_id!,
  chat_room_url: `/chats/${item.id}`,
});
