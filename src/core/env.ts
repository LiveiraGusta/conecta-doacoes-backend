import 'dotenv/config';
import { z } from 'zod';
import { parseAddress } from './email';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/**
 * Domínios de plataforma que estão na Public Suffix List: cada subdomínio é um "site" separado.
 * Front num deles e API em outro host = sites diferentes, e o cookie SameSite=Lax não vai nas
 * requisições do front. Por isso produção exige domínio próprio (ADR-13).
 */
const PLATFORM_SUFFIXES = ['vercel.app', 'onrender.com', 'netlify.app', 'railway.app', 'fly.dev', 'herokuapp.com', 'pages.dev', 'github.io'];

const onPlatformSuffix = (host: string) => PLATFORM_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));

/** Regras que só valem em produção: config errada aqui derruba o login sem erro aparente, então a API nem sobe. */
function checkProduction(e: { COOKIE_SECURE: boolean; BREVO_API_KEY?: string; RESEND_API_KEY?: string; CORS_ORIGIN: string[]; APP_URL: string; COOKIE_DOMAIN?: string }, ctx: z.RefinementCtx) {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });

  if (!e.COOKIE_SECURE) issue('COOKIE_SECURE', 'Obrigatório true em produção (HTTPS)');
  if (!e.BREVO_API_KEY && !e.RESEND_API_KEY) {
    issue('BREVO_API_KEY', 'Em produção, informe BREVO_API_KEY ou RESEND_API_KEY (recuperação de senha e notificações)');
  }
  if (e.CORS_ORIGIN.length === 0) issue('CORS_ORIGIN', 'Informe a origem do frontend (ex.: https://app.seudominio.com.br)');

  const cookieDomain = e.COOKIE_DOMAIN?.replace(/^\./, '');
  for (const origin of e.CORS_ORIGIN) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      issue('CORS_ORIGIN', `Origem inválida: ${origin}`);
      continue;
    }
    if (url.protocol !== 'https:') issue('CORS_ORIGIN', `Use https em produção: ${origin}`);
    if (url.origin !== origin) issue('CORS_ORIGIN', `Use só esquema + host, sem caminho nem barra final: ${url.origin}`);
    if (onPlatformSuffix(url.hostname)) {
      issue('CORS_ORIGIN', `${url.hostname} não serve: o cookie de sessão não funciona entre sites de plataforma. Use um domínio próprio (ADR-13)`);
    }
    if (cookieDomain && url.hostname !== cookieDomain && !url.hostname.endsWith(`.${cookieDomain}`)) {
      issue('COOKIE_DOMAIN', `${url.hostname} não está dentro de ${e.COOKIE_DOMAIN}`);
    }
  }

  const app = new URL(e.APP_URL);
  if (app.protocol !== 'https:') issue('APP_URL', 'Use https em produção');
  if (!e.CORS_ORIGIN.includes(app.origin)) issue('APP_URL', `${app.origin} precisa estar no CORS_ORIGIN (é o mesmo frontend)`);
}

/** O Brevo só aceita um remetente verificado no painel; o padrão do Resend nunca vai estar lá. */
function checkBrevoSender(from: string, ctx: z.RefinementCtx) {
  const sender = parseAddress(from);
  const message = !sender
    ? 'Use "Nome <email@exemplo.com>" ou só o e-mail'
    : sender.email.endsWith('@resend.dev')
      ? 'Com BREVO_API_KEY, use o e-mail verificado como remetente no Brevo (Senders), ex.: Conecta Doações <seuemail@gmail.com>'
      : undefined;
  if (message) ctx.addIssue({ code: 'custom', path: ['EMAIL_FROM'], message });
}

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3333),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
  // Vazio = só stdout. Com uma pasta (ex.: logs), também grava em arquivo com rotação (src/core/logger.ts).
  LOG_FILE_DIR: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  LOG_FILE_RETENTION: z.coerce.number().int().min(1).default(14), // arquivos guardados além do atual
  LOG_FILE_MAX_SIZE: z.string().regex(/^\d+[kmg]$/, 'Use um número seguido de k, m ou g (ex.: 20m)').default('20m'),
  TRUST_PROXY: bool.default(false),
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  STORAGE_BUCKET_ITEMS: z.string().default('items'),
  STORAGE_BUCKET_DOCS: z.string().default('ngo-docs'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de 32+ caracteres'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  // ── Sessão por cookie httpOnly (ADR-13) ──
  // Secure exige HTTPS: false só em dev (http://localhost). Front e API no mesmo site (app.<dom> + api.<dom>).
  COOKIE_SECURE: bool.default(false),
  // Opcional: domínio do cookie (ex.: .conectadoacoes.com.br). Vazio = só o host da API.
  COOKIE_DOMAIN: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(3).optional()),
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
  PUBLIC_RATE_LIMIT_MAX: z.coerce.number().int().default(60), // rotas /public/*, por IP (visitante)
  BODY_LIMIT_MB: z.coerce.number().default(1),
  UPLOAD_MAX_FILE_MB: z.coerce.number().default(5),
  SWAGGER_ENABLED: bool.default(false),
  // ── E-mail (recuperação de senha e notificações do fluxo) ──
  // Provedor: Brevo (sem domínio próprio, só o remetente verificado) tem prioridade sobre o Resend.
  // Sem nenhuma chave, o e-mail sai no log em vez de ser enviado (só fora de produção).
  BREVO_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().startsWith('xkeysib-').optional()),
  RESEND_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().startsWith('re_').optional()),
  EMAIL_FROM: z.string().min(3).default('Conecta Doações <onboarding@resend.dev>'),
  // Frontend: base dos links dos e-mails (APP_URL/redefinir-senha?token=…, APP_URL/chats/<item>…)
  APP_URL: z.url().default('http://localhost:5173'),
}).superRefine((e, ctx) => {
  if (e.BREVO_API_KEY) checkBrevoSender(e.EMAIL_FROM, ctx);
  if (e.NODE_ENV === 'production') checkProduction(e, ctx);
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Variáveis de ambiente inválidas:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';

/** Origens do frontend aceitas no CORS e no handshake do WebSocket. Em dev, o Vite (5173) entra sozinho. */
export const allowedOrigins: string[] =
  isProd || env.NODE_ENV === 'test' ? env.CORS_ORIGIN : [...new Set([...env.CORS_ORIGIN, 'http://localhost:5173'])];
