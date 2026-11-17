import { join, resolve } from 'node:path';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import fp from 'fastify-plugin';
import { env } from './env';

/**
 * Configuração do pino (logger do Fastify).
 *
 * Sempre escreve JSON no stdout: é o que o Render (e qualquer plataforma) coleta.
 * Com LOG_FILE_DIR, também grava em arquivo com rotação diária (ou ao passar de LOG_FILE_MAX_SIZE),
 * mantendo LOG_FILE_RETENTION arquivos. A gravação roda numa worker thread (transport do pino),
 * sem bloquear as requisições.
 */
export function loggerOptions(): FastifyServerOptions['logger'] {
  const base = {
    level: env.LOG_LEVEL,
    redact: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      'req.body.password',
      'req.body.new_password',
      'req.body.token',
    ],
  };
  if (!env.LOG_FILE_DIR) return base;

  return {
    ...base,
    transport: {
      targets: [
        { target: 'pino/file', level: env.LOG_LEVEL, options: { destination: 1 } }, // stdout
        {
          target: 'pino-roll',
          level: env.LOG_LEVEL,
          options: {
            // api.2026-11-17.1.log, api.2026-11-17.2.log…
            file: join(resolve(env.LOG_FILE_DIR), 'api'),
            extension: '.log',
            frequency: 'daily',
            dateFormat: 'yyyy-MM-dd',
            size: env.LOG_FILE_MAX_SIZE,
            mkdir: true,
            // removeOtherLogFiles: a retenção vale também para arquivos de execuções anteriores (tsx watch reinicia).
            limit: { count: env.LOG_FILE_RETENTION, removeOtherLogFiles: true },
          },
        },
      ],
    },
  };
}

/** Rotas de health check: o Render chama a cada poucos segundos; ficam só no nível debug. */
const QUIET_PATHS = new Set(['/health', '/health/ready']);

/**
 * Log de acesso: uma linha por requisição, gravada no fim da resposta.
 * Substitui o par "incoming request" / "request completed" do Fastify (disableRequestLogging).
 * Não registra corpo, cookie nem headers de autenticação.
 */
export const accessLogPlugin = fp(async (app: FastifyInstance) => {
  app.addHook('onResponse', async (req, reply) => {
    const status = reply.statusCode;
    const path = req.url.split('?', 1)[0] ?? req.url;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : QUIET_PATHS.has(path) ? 'debug' : 'info';

    // Campos soltos, e não em `req`/`res`: os serializadores padrão do Fastify reduziriam esses objetos.
    req.log[level](
      {
        method: req.method,
        url: req.url,
        route: req.routeOptions.url, // /api/v1/items/:id — agrupa por rota nas buscas
        statusCode: status,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        userId: req.user?.id,
        responseTime: Math.round(reply.elapsedTime * 10) / 10, // ms
      },
      'acesso',
    );
  });
});
