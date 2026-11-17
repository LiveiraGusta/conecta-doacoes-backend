import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError, type ErrorDetail } from './app-error';
import type { ErrorCode } from './catalog';

// Constraint única → código do contrato. Qualquer outra vira 409 CONFLICT.
const UNIQUE_CONSTRAINTS: Record<string, ErrorCode> = {
  users_email_key: 'EMAIL_TAKEN',
  ngo_profiles_cnpj_key: 'CNPJ_TAKEN',
  item_interests_item_id_ngo_id_key: 'ALREADY_INTERESTED',
  reports_open_per_reporter_key: 'ALREADY_REPORTED',
};

const TOO_LARGE_CODES = new Set([
  'FST_REQ_FILE_TOO_LARGE',
  'FST_FILES_LIMIT',
  'FST_PARTS_LIMIT',
  'FST_FIELDS_LIMIT',
  'FST_ERR_CTP_BODY_TOO_LARGE',
]);

interface ValidationIssue {
  instancePath?: string;
  message?: string;
  params?: Record<string, unknown>;
}

type AnyError = Error & {
  code?: string;
  statusCode?: number;
  validation?: ValidationIssue[];
  constraint_name?: string;
};

export const zodDetails = (err: ZodError): ErrorDetail[] =>
  err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

const validationDetails = (issues: ValidationIssue[]): ErrorDetail[] =>
  issues.map((v) => ({
    path:
      (v.instancePath ?? '').replace(/^\//, '').replaceAll('/', '.') ||
      String(v.params?.missingProperty ?? ''),
    message: v.message ?? 'Valor inválido',
  }));

/** Traduz qualquer erro (nosso, do Fastify, do Zod, do Postgres) para um AppError. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) return new AppError('VALIDATION_ERROR', undefined, zodDetails(error));

  const err = (error ?? {}) as AnyError;

  if (Array.isArray(err.validation)) {
    return new AppError('VALIDATION_ERROR', undefined, validationDetails(err.validation));
  }

  // Postgres
  if (err.code === '23505') return new AppError(UNIQUE_CONSTRAINTS[err.constraint_name ?? ''] ?? 'CONFLICT');
  if (err.code === '23503') return new AppError('NOT_FOUND');
  if (err.code === '22P02') return new AppError('VALIDATION_ERROR');

  if (err.code && TOO_LARGE_CODES.has(err.code)) return new AppError('PAYLOAD_TOO_LARGE');
  if (err.statusCode === 429) return new AppError('TOO_MANY_REQUESTS');
  if (err.statusCode === 413) return new AppError('PAYLOAD_TOO_LARGE');
  if (err.statusCode === 503) return new AppError('SERVICE_UNAVAILABLE');
  // Outros 4xx do Fastify: JSON malformado, content-type não suportado, corpo vazio.
  if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) return new AppError('VALIDATION_ERROR');

  return new AppError('INTERNAL_ERROR');
}

export const errorPlugin = fp(async (app) => {
  app.setErrorHandler((error, req, reply) => {
    const out = toAppError(error);
    if (out.status >= 500) req.log.error({ err: error }, 'erro não tratado');
    else req.log.info({ code: out.code }, 'erro de negócio');

    return reply
      .header('x-request-id', req.id)
      .status(out.status)
      .send({ error: out.code, message: out.message, ...(out.details ? { details: out.details } : {}) });
  });

  app.setNotFoundHandler((req, reply) =>
    reply
      .header('x-request-id', req.id)
      .status(404)
      .send({ error: 'NOT_FOUND', message: 'Rota não encontrada.' }),
  );
});
