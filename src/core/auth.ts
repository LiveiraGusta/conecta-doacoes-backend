import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import type { AuthUser, Role } from '../types';
import { AppError } from './errors';

export interface JwtPayload {
  sub: string;
  role: Role;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: AuthUser;
  }
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Rota acessível sem token. Toda rota nasce fechada. */
    public?: boolean;
  }
}

export interface AuthPluginOptions {
  findAuthContext(userId: string): Promise<AuthUser | null>;
}

/**
 * Autenticação fechada por padrão (ADR-11): o hook global exige JWT em tudo,
 * exceto rotas com `config.public = true`, a documentação e respostas 404.
 * O contexto vem do banco a cada requisição, para aprovação/rejeição de ONG valer na hora.
 */
export const authPlugin = fp<AuthPluginOptions>(async (app, opts) => {
  app.addHook('onRequest', async (req) => {
    if (req.method === 'OPTIONS' || req.is404 || req.routeOptions.config?.public) return;
    if (req.url === '/docs' || req.url.startsWith('/docs/')) return;

    let payload: JwtPayload;
    try {
      payload = await req.jwtVerify<JwtPayload>();
    } catch {
      throw new AppError('UNAUTHORIZED');
    }

    const user = await opts.findAuthContext(payload.sub);
    if (!user) throw new AppError('UNAUTHORIZED');
    req.user = user;
  });
});

/**
 * Chave de rate limit por usuário. O limite roda no onRequest, antes da autenticação,
 * então lê o `sub` do token sem verificar a assinatura: um token forjado só muda a chave
 * e cai no 401 logo depois. Sem token, a chave é o IP.
 */
export const userRateLimitKey = (req: FastifyRequest): string => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = req.server.jwt.decode<JwtPayload>(header.slice(7));
      if (payload?.sub) return `user:${payload.sub}`;
    } catch {
      // token malformado: cai para o IP
    }
  }
  return `ip:${req.ip}`;
};

export const requireRole =
  (...roles: Role[]) =>
  async (req: FastifyRequest) => {
    if (!roles.includes(req.user.role)) throw new AppError('FORBIDDEN');
  };

/** Só ONG com status ATIVO; ONG pendente ou rejeitada recebe NGO_NOT_APPROVED. */
export const requireActiveNgo = async (req: FastifyRequest) => {
  if (req.user.role !== 'NGO') throw new AppError('FORBIDDEN');
  if (req.user.ngoStatus !== 'ATIVO') throw new AppError('NGO_NOT_APPROVED');
};
