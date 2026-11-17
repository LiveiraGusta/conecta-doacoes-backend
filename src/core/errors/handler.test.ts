import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '../dto'; // configura as mensagens do Zod em PT-BR
import { AppError } from './app-error';
import { toAppError } from './handler';

const fastifyError = (props: Record<string, unknown>) => Object.assign(new Error('x'), props);

describe('toAppError', () => {
  it('mantém AppError como está', () => {
    const err = new AppError('ITEM_NOT_AVAILABLE');
    expect(toAppError(err)).toBe(err);
    expect(err).toMatchObject({ status: 409, message: 'Este item já está em negociação ou foi doado.' });
  });

  it('aceita mensagem específica sem mudar o status do catálogo', () => {
    expect(new AppError('FORBIDDEN', 'Apenas o doador do item pode escolher a ONG.')).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Apenas o doador do item pode escolher a ONG.',
    });
  });

  it('ZodError (parse manual de multipart) → 400 VALIDATION_ERROR com details', () => {
    const result = z.object({ title: z.string().min(3) }).safeParse({ title: 'a' });
    const out = toAppError(result.error);
    expect(out).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(out.details).toEqual([{ path: 'title', message: 'Mínimo de 3 caracteres' }]);
  });

  it('validação do Fastify → 400 VALIDATION_ERROR com path por campo', () => {
    const out = toAppError(
      fastifyError({ statusCode: 400, validation: [{ instancePath: '/email', message: 'E-mail inválido' }] }),
    );
    expect(out).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(out.details).toEqual([{ path: 'email', message: 'E-mail inválido' }]);
  });

  it.each([
    ['users_email_key', 'EMAIL_TAKEN'],
    ['ngo_profiles_cnpj_key', 'CNPJ_TAKEN'],
    ['item_interests_item_id_ngo_id_key', 'ALREADY_INTERESTED'],
    ['outra_constraint', 'CONFLICT'],
  ])('Postgres 23505 em %s → 409 %s', (constraint_name, code) => {
    expect(toAppError(fastifyError({ code: '23505', constraint_name }))).toMatchObject({ status: 409, code });
  });

  it('Postgres 23503 (foreign key) → 404 NOT_FOUND', () => {
    expect(toAppError(fastifyError({ code: '23503' }))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('rate limit → 429 TOO_MANY_REQUESTS', () => {
    expect(toAppError(fastifyError({ statusCode: 429 }))).toMatchObject({ status: 429, code: 'TOO_MANY_REQUESTS' });
  });

  it.each(['FST_REQ_FILE_TOO_LARGE', 'FST_FILES_LIMIT', 'FST_ERR_CTP_BODY_TOO_LARGE'])(
    'multipart/corpo acima do limite (%s) → 413 PAYLOAD_TOO_LARGE',
    (code) => {
      expect(toAppError(fastifyError({ code, statusCode: 413 }))).toMatchObject({
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
      });
    },
  );

  it('sobrecarga (under-pressure) → 503 SERVICE_UNAVAILABLE', () => {
    expect(toAppError(fastifyError({ statusCode: 503 }))).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
  });

  it('JSON malformado ou outro 4xx do Fastify → 400 VALIDATION_ERROR', () => {
    expect(toAppError(fastifyError({ code: 'FST_ERR_CTP_INVALID_JSON_BODY', statusCode: 400 }))).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  it('qualquer outro erro → 500 INTERNAL_ERROR, sem vazar a mensagem original', () => {
    const out = toAppError(new Error('relation "items" does not exist'));
    expect(out).toMatchObject({ status: 500, code: 'INTERNAL_ERROR', message: 'Erro inesperado. Tente de novo.' });
  });
});
