import { z } from 'zod';
import { text, UF } from '../../core/dto';
import { Password } from '../auth/auth.dto';

const NullableWebsite = z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v),
  z
    .string()
    .max(255)
    .pipe(z.url({ protocol: /^https?$/, error: 'URL inválida (use http:// ou https://)' }))
    .nullable(),
);

export const UpdateProfileBody = z
  .object({
    name: text(2, 255).optional(),
    city: text(2, 100).optional(),
    state: UF.optional(),
    /** Só ONG; null apaga. */
    website: NullableWebsite.optional(),
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
