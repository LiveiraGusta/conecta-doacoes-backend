import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply } from 'fastify';
import { env } from './env';

/** Nome do cookie de sessão (JWT). O JS do navegador nunca o lê: é httpOnly. */
export const SESSION_COOKIE = 'cd_session';

/** Mesmo prazo do JWT_EXPIRES_IN padrão (7 dias). */
const MAX_AGE_S = 7 * 24 * 60 * 60;

/**
 * Atributos num lugar só: o navegador só apaga o cookie se o clear repetir path, domain,
 * sameSite e secure de quando ele foi criado.
 * SameSite=Lax: front e API ficam no mesmo site (ADR-13), e o Lax já barra POST vindo de outro site.
 */
const baseOptions = (): CookieSerializeOptions => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'lax',
  path: '/api/v1',
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
});

export const setSessionCookie = (reply: FastifyReply, token: string) =>
  reply.setCookie(SESSION_COOKIE, token, { ...baseOptions(), maxAge: MAX_AGE_S });

export const clearSessionCookie = (reply: FastifyReply) => reply.clearCookie(SESSION_COOKIE, baseOptions());
