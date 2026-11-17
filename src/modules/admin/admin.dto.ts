import { z } from 'zod';
import { isoDate, NgoStatus, optionalText, PaginationQuery, toIso, UF } from '../../core/dto';
import type { NgoStatus as NgoStatusT } from '../../types';

// ── Entrada ──
export const ListNgosQuery = PaginationQuery.extend({
  status: NgoStatus.default('PENDENTE_APROVACAO'),
});
export type ListNgosQuery = z.infer<typeof ListNgosQuery>;

export const NgoProfileIdParams = z.object({ ngoProfileId: z.uuid() });
export type NgoProfileIdParams = z.infer<typeof NgoProfileIdParams>;

export const UpdateNgoStatusBody = z
  .object({
    status: z.enum(['ATIVO', 'REJEITADO']),
    rejection_reason: optionalText(1000),
  })
  .superRefine((body, ctx) => {
    if (body.status === 'REJEITADO' && (body.rejection_reason?.length ?? 0) < 10) {
      ctx.addIssue({
        code: 'custom',
        path: ['rejection_reason'],
        message: 'Informe o motivo da rejeição (mínimo de 10 caracteres)',
      });
    }
  });
export type UpdateNgoStatusBody = z.infer<typeof UpdateNgoStatusBody>;

// ── Saída ──
export const AdminNgoDto = z
  .object({
    ngo_profile_id: z.uuid(),
    user_id: z.uuid(),
    name: z.string(),
    email: z.string(),
    city: z.string(),
    state: UF,
    cnpj: z.string(),
    website: z.string().nullable(),
    document_url: z.string().describe('URL assinada, expira em 10 minutos'),
    status: NgoStatus,
    rejection_reason: z.string().nullable(),
    created_at: isoDate(),
  })
  .describe('AdminNgo');

export const AdminNgoListDto = z.object({ total: z.number().int().min(0), data: z.array(AdminNgoDto) });
export type AdminNgoListDto = z.infer<typeof AdminNgoListDto>;

export const NgoStatusResultDto = z.object({
  id: z.uuid(),
  status: z.enum(['ATIVO', 'REJEITADO']),
  rejection_reason: z.string().nullable(),
});
export type NgoStatusResultDto = z.infer<typeof NgoStatusResultDto>;

// ── Mapeamento ──
export interface AdminNgo {
  ngo_profile_id: string;
  user_id: string;
  name: string;
  email: string;
  city: string;
  state: string;
  cnpj: string;
  website: string | null;
  document_url: string;
  status: NgoStatusT;
  rejection_reason: string | null;
  created_at: Date;
}

export const toAdminNgoListDto = (r: { total: number; data: AdminNgo[] }): AdminNgoListDto => ({
  total: r.total,
  data: r.data.map((n) => ({
    ...n,
    state: n.state as AdminNgoListDto['data'][number]['state'],
    created_at: toIso(n.created_at),
  })),
});

export const toNgoStatusResultDto = (p: {
  id: string;
  status: NgoStatusT;
  rejection_reason: string | null;
}): NgoStatusResultDto => ({
  id: p.id,
  status: p.status as NgoStatusResultDto['status'],
  rejection_reason: p.rejection_reason,
});
