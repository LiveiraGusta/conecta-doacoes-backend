import { z } from 'zod';
import { Category, optionalText, text, ThemeColor, ThemeMode, UF } from '../../core/dto';
import { Password } from '../auth/auth.dto';

const NullableWebsite = z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v),
  z
    .string()
    .max(255)
    .pipe(z.url({ protocol: /^https?$/, error: 'URL inválida (use http:// ou https://)' }))
    .nullable(),
);

/** '' ou só espaços vira null (apaga). */
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

const NullableBio = z.preprocess(blankToNull, z.string().trim().max(500).nullable());

/** Aceita com ou sem máscara; guarda só os dígitos, com DDD: (11) 98765-4321 → 11987654321. */
export const Phone = z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.replace(/\D/g, '')) : v),
  z
    .string()
    .regex(/^[1-9][0-9]{9,10}$/, 'Telefone inválido: informe DDD e número (10 ou 11 dígitos)')
    .nullable(),
);

/** Aceita "ong", "@ong" ou a URL do perfil; guarda só o usuário, em minúsculas. */
export const Instagram = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v.trim() === ''
        ? null
        : v
            .trim()
            .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
            .replace(/[/?#].*$/, '')
            .replace(/^@/, '')
            .toLowerCase()
      : v,
  z
    .string()
    .regex(/^(?!\.)(?!.*\.\.)[a-z0-9._]{1,30}(?<!\.)$/, 'Usuário do Instagram inválido')
    .nullable(),
);

/** Sem repetição; a ordem de envio é mantida. */
const AcceptedCategories = z
  .array(Category)
  .max(4)
  .transform((list) => [...new Set(list)]);

/** CEP com ou sem hífen; guarda os 8 dígitos. */
export const Cep = z.preprocess(
  (v) => (typeof v === 'string' ? v.replace(/\D/g, '') : v),
  z.string().regex(/^[0-9]{8}$/, 'CEP inválido (8 dígitos)'),
);

/** Endereço completo (o complemento é opcional) ou null para apagar. */
export const AddressBody = z
  .object({
    cep: Cep,
    street: text(2, 200),
    number: text(1, 20),
    complement: optionalText(100),
    neighborhood: text(2, 100),
  })
  .nullable();
export type AddressBody = z.infer<typeof AddressBody>;

/** Campos que só ONG pode enviar no PATCH /profile. */
export const NGO_ONLY_FIELDS = ['website', 'phone', 'instagram', 'accepted_categories', 'address'] as const;

export const UpdateProfileBody = z
  .object({
    name: text(2, 255).optional(),
    city: text(2, 100).optional(),
    state: UF.optional(),
    /** Doador e ONG; null ou vazio apaga. */
    bio: NullableBio.optional(),
    /** Só ONG; null apaga. */
    website: NullableWebsite.optional(),
    phone: Phone.optional(),
    instagram: Instagram.optional(),
    accepted_categories: AcceptedCategories.optional(),
    address: AddressBody.optional(),
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({ code: 'custom', path: [], message: 'Envie ao menos um campo para atualizar' });
    }
    if ((v.city === undefined) !== (v.state === undefined)) {
      ctx.addIssue({ code: 'custom', path: [v.city === undefined ? 'city' : 'state'], message: 'Informe cidade e UF juntas' });
    }
  });
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

export const ChangePasswordBody = z.object({
  current_password: z.string().min(1),
  new_password: Password,
});
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;

export const DeleteAccountBody = z.object({ password: z.string().min(1) });
export type DeleteAccountBody = z.infer<typeof DeleteAccountBody>;

export const UpdatePreferencesBody = z
  .object({
    theme_color: ThemeColor.optional(),
    theme_mode: ThemeMode.optional(),
    /** Só doador: mostrar as doações concluídas na página pessoal. */
    show_donations: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Envie ao menos uma preferência', path: [] });
export type UpdatePreferencesBody = z.infer<typeof UpdatePreferencesBody>;
