import { z } from 'zod';
import { Category, isoDate, NgoStatus, PaginationQuery, toIso, UF } from '../../core/dto';
import type { ItemView, Page, UserProfileRow, UserProfileView } from '../../types';
import { AddressDto } from '../auth/auth.dto';
import { abbreviateName, FeedItemDto, toFeedItemDto, type ViewerContext } from '../items/items.dto';

// ── Entrada ──
export const UserIdParams = z.object({ userId: z.uuid() });
export type UserIdParams = z.infer<typeof UserIdParams>;

export const UserDonationsQuery = PaginationQuery;
export type UserDonationsQuery = z.infer<typeof UserDonationsQuery>;

// ── Saída ──
const PartyRole = z.enum(['DONOR', 'NGO']);

export const UserProfileNgoDto = z
  .object({
    status: NgoStatus,
    website: z.string().nullable(),
    banner_url: z.string().nullable(),
    accepted_categories: z.array(Category),
    /** Endereço e contatos: só de ONG ATIVO (ou para a própria ONG). */
    phone: z.string().nullable(),
    instagram: z.string().nullable(),
    address: AddressDto.nullable(),
  })
  .describe('UserProfileNgo');

export const UserProfileDto = z
  .object({
    id: z.uuid(),
    role: PartyRole,
    /** Doador: abreviado ("Marina S."). ONG: nome completo. */
    name: z.string(),
    avatar_url: z.string().nullable(),
    bio: z.string().nullable(),
    city: z.string(),
    state: UF,
    member_since: isoDate(),
    /** Doações concluídas (doadas ou recebidas). null = o doador escolheu não mostrar. */
    donations_count: z.number().int().min(0).nullable(),
    ngo: UserProfileNgoDto.nullable(),
  })
  .describe('UserProfile');
export type UserProfileDto = z.infer<typeof UserProfileDto>;

export const UserDonationsDto = z
  .object({ total: z.number().int().min(0), data: z.array(FeedItemDto), hidden: z.boolean() })
  .describe('UserDonations');
export type UserDonationsDto = z.infer<typeof UserDonationsDto>;

/** Página pessoal para visitante: sem nome, foto, banner, endereço nem contatos. */
export const PublicUserDto = z
  .object({
    id: z.uuid(),
    role: PartyRole,
    city: z.string(),
    state: UF,
    bio: z.string().nullable(),
    accepted_categories: z.array(Category),
    donations_count: z.number().int().min(0).nullable(),
  })
  .strict()
  .describe('PublicUser');
export type PublicUserDto = z.infer<typeof PublicUserDto>;

// ── Mapeamento ──
const addressOf = (r: UserProfileRow) =>
  r.cep && r.street && r.number && r.neighborhood
    ? { cep: r.cep, street: r.street, number: r.number, complement: r.complement ?? null, neighborhood: r.neighborhood }
    : null;

export const toUserProfileDto = ({ row: r, donationsHidden, showNgoContact }: UserProfileView): UserProfileDto => ({
  id: r.id,
  role: r.role as UserProfileDto['role'],
  name: r.role === 'DONOR' ? abbreviateName(r.name) : r.name,
  avatar_url: r.avatar_url,
  bio: r.bio,
  city: r.city,
  state: r.state as UserProfileDto['state'],
  member_since: toIso(r.created_at),
  donations_count: donationsHidden ? null : r.donations_count,
  ngo:
    r.role === 'NGO' && r.ngo_status
      ? {
          status: r.ngo_status,
          website: r.website,
          banner_url: r.banner_url,
          accepted_categories: r.accepted_categories,
          phone: showNgoContact ? r.phone : null,
          instagram: showNgoContact ? r.instagram : null,
          address: showNgoContact ? addressOf(r) : null,
        }
      : null,
});

export const toUserDonationsDto = (p: Page<ItemView & ViewerContext> & { hidden: boolean }): UserDonationsDto => ({
  total: p.total,
  data: p.rows.map(toFeedItemDto),
  hidden: p.hidden,
});

export const toPublicUserDto = ({ row: r, donationsHidden }: { row: UserProfileRow; donationsHidden: boolean }): PublicUserDto => ({
  id: r.id,
  role: r.role as PublicUserDto['role'],
  city: r.city,
  state: r.state as PublicUserDto['state'],
  bio: r.bio,
  accepted_categories: r.role === 'NGO' ? r.accepted_categories : [],
  donations_count: donationsHidden ? null : r.donations_count,
});
