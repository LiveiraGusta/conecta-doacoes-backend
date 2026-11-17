import type { FastifyReply, FastifyRequest } from 'fastify';
import type { HealthDto, ReadinessDto } from './health.dto';

export interface HealthDeps {
  version: string;
  /** SELECT 1 com timeout; devolve a latência em ms ou lança. */
  pingDb(timeoutMs: number): Promise<number>;
}

export const createHealthController = ({ version, pingDb }: HealthDeps) => ({
  live: async (_req: FastifyRequest, reply: FastifyReply) => {
    const body: HealthDto = { status: 'ok', version, uptime_s: Math.floor(process.uptime()) };
    return reply.status(200).send(body);
  },

  ready: async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const latency = await pingDb(2000);
      const body: ReadinessDto = { status: 'ok', version, checks: { database: { status: 'ok', latency_ms: latency } } };
      return reply.status(200).send(body);
    } catch (err) {
      req.log.warn({ err }, 'readiness: banco indisponível');
      // Sem detalhes do driver: só "timeout" ou "unavailable".
      const reason = err instanceof Error && err.message === 'timeout' ? 'timeout' : 'unavailable';
      const body: ReadinessDto = { status: 'error', version, checks: { database: { status: 'error', error: reason } } };
      return reply.status(503).send(body);
    }
  },
});

export type HealthController = ReturnType<typeof createHealthController>;
