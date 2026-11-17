import { z } from 'zod';

export const HealthDto = z
  .object({
    status: z.literal('ok'),
    version: z.string(),
    uptime_s: z.number().int().min(0),
  })
  .describe('Health');
export type HealthDto = z.infer<typeof HealthDto>;

export const ReadinessDto = z
  .object({
    status: z.enum(['ok', 'error']),
    version: z.string(),
    checks: z.object({
      database: z.object({
        status: z.enum(['ok', 'error']),
        latency_ms: z.number().int().min(0).optional(),
        error: z.string().optional(),
      }),
    }),
  })
  .describe('Readiness');
export type ReadinessDto = z.infer<typeof ReadinessDto>;
