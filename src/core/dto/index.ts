import { z } from 'zod';

// ── Mensagens de validação em português do Brasil ──
// O locale `pt` do Zod é de Portugal; os casos comuns ganham texto próprio e o resto cai nele.
z.config(z.locales.pt());
z.config({
  customError: (iss) => {
    if (iss.code === 'invalid_type' && iss.input === undefined) return 'Campo obrigatório';
    if (iss.code === 'too_small' && iss.origin === 'string') {
      return Number(iss.minimum) <= 1 ? 'Campo obrigatório' : `Mínimo de ${iss.minimum} caracteres`;
    }
    if (iss.code === 'too_big' && iss.origin === 'string') return `Máximo de ${iss.maximum} caracteres`;
    if (iss.code === 'too_small' && iss.origin === 'number') return `Deve ser no mínimo ${iss.minimum}`;
    if (iss.code === 'too_big' && iss.origin === 'number') return `Deve ser no máximo ${iss.maximum}`;
    if (iss.code === 'invalid_format') {
      if (iss.format === 'email') return 'E-mail inválido';
      if (iss.format === 'uuid') return 'Identificador inválido';
      if (iss.format === 'url') return 'URL inválida';
      if (iss.format === 'datetime') return 'Data inválida (use ISO 8601)';
    }
    if (iss.code === 'invalid_value') return 'Valor não permitido';
    return undefined;
  },
});

// ── Enums do contrato ──
export const UF_LIST = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;
export const UF = z.enum(UF_LIST);
export const Role = z.enum(['DONOR', 'NGO', 'ADMIN']);
export const NgoStatus = z.enum(['PENDENTE_APROVACAO', 'ATIVO', 'REJEITADO']);
export const Category = z.enum(['ROUPAS', 'BRINQUEDOS', 'ALIMENTOS', 'LIVROS']);
export const ItemStatus = z.enum(['DISPONIVEL', 'EM_PROGRESSO', 'DOADO']);
export const ThemeColor = z.enum(['AZUL', 'VERDE', 'ROXO', 'LARANJA', 'ROSA']);
export const ThemeMode = z.enum(['LIGHT', 'DARK', 'SYSTEM']);

// ── Helpers de entrada ──
/** Texto obrigatório: trim antes de validar. */
export const text = (min: number, max: number) => z.string().trim().min(min).max(max);
/** Texto opcional: vazio depois do trim conta como ausente. */
export const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().max(max).optional(),
  );

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;

export const ItemIdParams = z.object({ itemId: z.uuid() });
export type ItemIdParams = z.infer<typeof ItemIdParams>;

// ── Helpers de saída ──
export const isoDate = () => z.iso.datetime();
export const toIso = (d: Date | string): string => (d instanceof Date ? d : new Date(d)).toISOString();
export const toIsoOrNull = (d: Date | string | null | undefined): string | null => (d ? toIso(d) : null);

export const ErrorDto = z
  .object({
    error: z.string(),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .describe('Error');

/** Respostas de erro comuns, para declarar em `schema.response` das rotas. */
export const errorResponses = (...statuses: number[]) =>
  Object.fromEntries(statuses.map((s) => [s, ErrorDto])) as Record<number, typeof ErrorDto>;
