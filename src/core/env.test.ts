import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EnvSchema } from './env';

// Produção com domínio próprio: front em app.<dom> e API em api.<dom> (ADR-13).
const prod = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pass@pooler.supabase.com:6543/postgres',
  SUPABASE_URL: 'https://projeto.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40),
  JWT_SECRET: 's'.repeat(48),
  COOKIE_SECURE: 'true',
  COOKIE_DOMAIN: '.conectadoacoes.com.br',
  CORS_ORIGIN: 'https://app.conectadoacoes.com.br',
  APP_URL: 'https://app.conectadoacoes.com.br',
  RESEND_API_KEY: 're_chave',
};

function errors(overrides: Record<string, string | undefined>) {
  const result = EnvSchema.safeParse({ ...prod, ...overrides });
  return result.success ? {} : z.flattenError(result.error).fieldErrors;
}

describe('variáveis de ambiente em produção', () => {
  it('aceita a configuração com domínio próprio', () => {
    expect(errors({})).toEqual({});
  });

  it('aceita a configuração sem COOKIE_DOMAIN (cookie só no host da API)', () => {
    expect(errors({ COOKIE_DOMAIN: undefined })).toEqual({});
  });

  it('exige COOKIE_SECURE=true', () => {
    expect(errors({ COOKIE_SECURE: 'false' })).toHaveProperty('COOKIE_SECURE');
  });

  it('exige a chave do Resend', () => {
    expect(errors({ RESEND_API_KEY: undefined })).toHaveProperty('RESEND_API_KEY');
  });

  it('recusa front em domínio de plataforma (*.vercel.app, *.onrender.com)', () => {
    for (const origin of ['https://conectadoacoes.vercel.app', 'https://conecta.onrender.com']) {
      const errs = errors({ CORS_ORIGIN: origin, APP_URL: origin, COOKIE_DOMAIN: undefined });
      expect(errs.CORS_ORIGIN?.join(' ')).toContain('ADR-13');
    }
  });

  it('recusa origem sem https', () => {
    const origin = 'http://app.conectadoacoes.com.br';
    expect(errors({ CORS_ORIGIN: origin })).toHaveProperty('CORS_ORIGIN');
  });

  it('recusa origem com barra final ou caminho', () => {
    expect(errors({ CORS_ORIGIN: 'https://app.conectadoacoes.com.br/' })).toHaveProperty('CORS_ORIGIN');
  });

  it('exige que o APP_URL esteja no CORS_ORIGIN', () => {
    expect(errors({ APP_URL: 'https://www.conectadoacoes.com.br' })).toHaveProperty('APP_URL');
  });

  it('exige APP_URL com https', () => {
    const errs = errors({ APP_URL: 'http://app.conectadoacoes.com.br' });
    expect(errs.APP_URL?.join(' ')).toContain('https');
  });

  it('recusa origem fora do COOKIE_DOMAIN', () => {
    const origin = 'https://app.outrodominio.com.br';
    expect(errors({ CORS_ORIGIN: origin, APP_URL: origin })).toHaveProperty('COOKIE_DOMAIN');
  });

  it('aceita várias origens dentro do mesmo domínio', () => {
    const errs = errors({ CORS_ORIGIN: 'https://app.conectadoacoes.com.br,https://www.conectadoacoes.com.br' });
    expect(errs).toEqual({});
  });
});

describe('variáveis de ambiente fora de produção', () => {
  it('não aplica as regras de produção (http e localhost liberados)', () => {
    const errs = errors({
      NODE_ENV: 'development',
      COOKIE_SECURE: 'false',
      CORS_ORIGIN: 'http://localhost:5173',
      APP_URL: 'http://localhost:5173',
      COOKIE_DOMAIN: undefined,
      RESEND_API_KEY: undefined,
    });
    expect(errs).toEqual({});
  });
});
