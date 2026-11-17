import 'dotenv/config';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3333),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
  TRUST_PROXY: bool.default(false),
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  STORAGE_BUCKET_ITEMS: z.string().default('items'),
  STORAGE_BUCKET_DOCS: z.string().default('ngo-docs'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de 32+ caracteres'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGIN: z.string().transform((s) =>
    s
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  ),
  RATE_LIMIT_MAX: z.coerce.number().int().default(120),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().default(10),
  ITEMS_RATE_LIMIT_MAX: z.coerce.number().int().default(10), // POST /items, por usuário
  MESSAGES_RATE_LIMIT_MAX: z.coerce.number().int().default(30), // POST /chats/:id/messages, por usuário
  BODY_LIMIT_MB: z.coerce.number().default(1),
  UPLOAD_MAX_FILE_MB: z.coerce.number().default(5),
  SWAGGER_ENABLED: bool.default(false),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error('Variáveis de ambiente inválidas:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
