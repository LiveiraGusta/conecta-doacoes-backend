import { z } from 'zod';
import { normalizeCnpj } from '../../core/cnpj';
import { Category, NgoStatus, Role, text, ThemeColor, ThemeMode, UF } from '../../core/dto';
import { PASSWORD_RULE } from '../../core/passwords';
import type { NgoProfile, UserPreferences, UserWithProfile } from '../../types';

// ── Entrada ──
export const Email = z.string().trim().toLowerCase().max(255).pipe(z.email());

export const Password = z
  .string()
  .min(PASSWORD_RULE.min)
  .max(PASSWORD_RULE.max)
  .refine(PASSWORD_RULE.test, PASSWORD_RULE.message);

export const Cnpj = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const masked = normalizeCnpj(value);
    if (!masked) {
      ctx.addIssue({ code: 'custom', message: 'CNPJ inválido' });
      return z.NEVER;
    }
    return masked;
  });

export const Website = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v),
  z
    .string()
    .max(255)
    .pipe(z.url({ protocol: /^https?$/, error: 'URL inválida (use http:// ou https://)' }))
    .optional(),
);

export const RegisterDonorBody = z.object({
  name: text(2, 255),
  email: Email,
  password: Password,
  city: text(2, 100),
  state: UF,
});
export type RegisterDonorBody = z.infer<typeof RegisterDonorBody>;

/** Campos de texto do multipart de cadastro de ONG (o arquivo `document` é lido à parte). */
export const RegisterNgoFields = RegisterDonorBody.extend({
  cnpj: Cnpj,
  website: Website,
});
export type RegisterNgoFields = z.infer<typeof RegisterNgoFields>;

export const LoginBody = z.object({
  email: Email,
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof LoginBody>;

export const ForgotPasswordBody = z.object({ email: Email });
export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBody>;

export const ResetPasswordBody = z.object({
  token: z.string().trim().min(1).max(200),
  new_password: Password,
});
export type ResetPasswordBody = z.infer<typeof ResetPasswordBody>;

// ── Saída ──
export const AddressDto = z
  .object({
    cep: z.string(),
    street: z.string(),
    number: z.string(),
    complement: z.string().nullable(),
    neighborhood: z.string(),
  })
  .describe('Address');
export type AddressDto = z.infer<typeof AddressDto>;

export const NgoProfileDto = z
  .object({
    id: z.uuid(),
    cnpj: z.string(),
    website: z.string().nullable(),
    status: NgoStatus,
    rejection_reason: z.string().nullable(),
    banner_url: z.string().nullable(),
    phone: z.string().nullable(),
    instagram: z.string().nullable(),
    accepted_categories: z.array(Category),
    address: AddressDto.nullable(),
  })
  .describe('NgoProfile');

export const PreferencesDto = z
  .object({ theme_color: ThemeColor, theme_mode: ThemeMode, show_donations: z.boolean() })
  .describe('Preferences');
export type PreferencesDto = z.infer<typeof PreferencesDto>;

/** Usuário sem linha em user_preferences usa estes valores. */
export const DEFAULT_PREFERENCES: UserPreferences = { theme_color: 'AZUL', theme_mode: 'SYSTEM', show_donations: false };

export const toPreferencesDto = (p: UserPreferences | null | undefined): PreferencesDto => ({
  theme_color: p?.theme_color ?? DEFAULT_PREFERENCES.theme_color,
  theme_mode: p?.theme_mode ?? DEFAULT_PREFERENCES.theme_mode,
  show_donations: p?.show_donations ?? DEFAULT_PREFERENCES.show_donations,
});

export const toAddressDto = (np: NgoProfile): AddressDto | null =>
  np.cep && np.street && np.number && np.neighborhood
    ? { cep: np.cep, street: np.street, number: np.number, complement: np.complement ?? null, neighborhood: np.neighborhood }
    : null;

export const UserDto = z
  .object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    role: Role,
    city: z.string(),
    state: UF,
    bio: z.string().nullable(),
    avatar_url: z.string().nullable(),
    preferences: PreferencesDto,
    ngo_profile: NgoProfileDto.optional(),
  })
  .describe('User');
export type UserDto = z.infer<typeof UserDto>;

/** O token não vai no corpo: ele sai só no cookie httpOnly `cd_session` (ADR-13). */
export const AuthResponseDto = z.object({ user: UserDto }).describe('AuthResponse');
export type AuthResponseDto = z.infer<typeof AuthResponseDto>;

export const MeResponseDto = z.object({ user: UserDto });

/** document_url nunca sai daqui: só as rotas /admin devolvem o documento. */
export const toUserDto = (u: UserWithProfile): UserDto => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  city: u.city,
  state: u.state as UserDto['state'],
  bio: u.bio ?? null,
  avatar_url: u.avatar_url ?? null,
  preferences: toPreferencesDto(u.preferences),
  ...(u.role === 'NGO' && u.ngo_profile
    ? {
        ngo_profile: {
          id: u.ngo_profile.id,
          cnpj: u.ngo_profile.cnpj,
          website: u.ngo_profile.website,
          status: u.ngo_profile.status,
          rejection_reason: u.ngo_profile.rejection_reason,
          banner_url: u.ngo_profile.banner_url ?? null,
          phone: u.ngo_profile.phone ?? null,
          instagram: u.ngo_profile.instagram ?? null,
          accepted_categories: u.ngo_profile.accepted_categories ?? [],
          address: toAddressDto(u.ngo_profile),
        },
      }
    : {}),
});

export const toAuthResponseDto = (r: { user: UserWithProfile }): AuthResponseDto => ({ user: toUserDto(r.user) });
