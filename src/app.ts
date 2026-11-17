import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import underPressure from '@fastify/under-pressure';
import websocket from '@fastify/websocket';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import pkg from '../package.json' with { type: 'json' };
import './core/dto'; // mensagens de validação do Zod em PT-BR
import { authPlugin } from './core/auth';
import { createDb, type Db } from './core/db';
import { createLogMailer, createResendMailer, type Mailer } from './core/email';
import { allowedOrigins, env } from './core/env';
import { AppError } from './core/errors';
import { errorPlugin } from './core/errors/handler';
import { bcryptHasher } from './core/passwords';
import { createMemoryBus, type RealtimeBus } from './core/realtime';
import { SESSION_COOKIE } from './core/session-cookie';
import { createSupabaseStorage, type Storage } from './core/storage';
import { createAdminController } from './modules/admin/admin.controller';
import { adminRepository } from './modules/admin/admin.repository';
import { adminRoutes } from './modules/admin/admin.routes';
import { createAdminService } from './modules/admin/admin.service';
import { createChatsController } from './modules/chats/chats.controller';
import { chatsRepository } from './modules/chats/chats.repository';
import { chatsRoutes } from './modules/chats/chats.routes';
import { createChatsService } from './modules/chats/chats.service';
import { chatsWebsocket } from './modules/chats/chats.ws';
import { createAuthController } from './modules/auth/auth.controller';
import { authRepository } from './modules/auth/auth.repository';
import { authRoutes } from './modules/auth/auth.routes';
import { createAuthService } from './modules/auth/auth.service';
import { createPasswordResetService } from './modules/auth/password-reset.service';
import { passwordResetsRepository } from './modules/auth/password-resets.repository';
import { createInterestsController } from './modules/interests/interests.controller';
import { interestsRepository } from './modules/interests/interests.repository';
import { interestsRoutes } from './modules/interests/interests.routes';
import { createInterestsService } from './modules/interests/interests.service';
import { createProfileController } from './modules/profile/profile.controller';
import { profileRepository } from './modules/profile/profile.repository';
import { profileRoutes } from './modules/profile/profile.routes';
import { createProfileService } from './modules/profile/profile.service';
import { createReportsController } from './modules/reports/reports.controller';
import { reportsRepository } from './modules/reports/reports.repository';
import { reportsRoutes } from './modules/reports/reports.routes';
import { createReportsService } from './modules/reports/reports.service';
import { createHealthController } from './modules/health/health.controller';
import { itemEventsRepository } from './modules/items/item-events.repository';
import { createItemsController } from './modules/items/items.controller';
import { itemsRepository } from './modules/items/items.repository';
import { itemsRoutes } from './modules/items/items.routes';
import { createItemsService } from './modules/items/items.service';
import { healthRoutes } from './modules/health/health.routes';
import { createUsersController } from './modules/users/users.controller';
import { usersRepository } from './modules/users/users.repository';
import { usersRoutes } from './modules/users/users.routes';
import { createUsersService } from './modules/users/users.service';

export interface BuildAppOptions {
  /** Injetado nos testes; por padrão cria o pool a partir de DATABASE_URL. */
  db?: Db;
  /** Injetado nos testes (fake em memória); por padrão usa o Supabase Storage. */
  storage?: Storage;
  logger?: boolean;
  /** Barramento de eventos do chat; por padrão, em memória (1 instância). */
  bus?: RealtimeBus;
  /** Envio de e-mail; por padrão Resend (com RESEND_API_KEY) ou log. Fake nos testes. */
  mailer?: Mailer;
  /** Recebe cada rota registrada (usado pelo teste que exige 401 em toda rota não pública). */
  onRoute?: (route: RouteOptions) => void;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const db = opts.db ?? createDb();
  const storage = opts.storage ?? createSupabaseStorage();
  const bus = opts.bus ?? createMemoryBus();

  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: env.LOG_LEVEL,
            redact: ['req.headers.cookie', 'req.body.password', 'req.body.new_password', 'req.body.token'],
          },
    trustProxy: env.TRUST_PROXY,
    bodyLimit: env.BODY_LIMIT_MB * 1024 * 1024,
    connectionTimeout: 10_000,
    requestTimeout: 30_000,
  });

  if (opts.onRoute) app.addHook('onRoute', opts.onRoute);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // ── Segurança, na ordem do ADR-11 ──
  await app.register(underPressure, {
    maxEventLoopDelay: 1000,
    maxHeapUsedBytes: 400 * 1024 * 1024,
    retryAfter: 10,
  });
  await app.register(helmet, { contentSecurityPolicy: false }); // API JSON; a CSP fica no frontend
  await app.register(cors, {
    origin: allowedOrigins,
    // Sessão em cookie httpOnly (ADR-13): o navegador só envia o cookie com credentials.
    credentials: true,
    allowedHeaders: ['content-type', 'x-requested-with'],
    // O front mostra o x-request-id nas telas de erro; sem expor, ele não consegue ler.
    exposedHeaders: ['x-request-id'],
  });
  // Antes do rate limit: a chave por usuário (userRateLimitKey) lê o cookie de sessão.
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // req.ip pode faltar em sockets injetados (testes de WebSocket); sem fallback o plugin quebra.
    keyGenerator: (req) => req.ip || 'unknown',
    errorResponseBuilder: () => Object.assign(new AppError('TOO_MANY_REQUESTS'), { statusCode: 429 }),
  });
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
    cookie: { cookieName: SESSION_COOKIE, signed: false },
    // Só cookie: sem isso o @fastify/jwt dá prioridade ao header Authorization.
    verify: { onlyCookie: true },
  });
  await app.register(errorPlugin);
  await app.register(authPlugin, {
    findAuthContext: (userId) => authRepository.findAuthContext(db.sql, userId),
  });
  await app.register(websocket, {
    options: { maxPayload: 16 * 1024 },
    // No deploy/encerramento, fecha com 1001 (going away): o cliente sabe que deve reconectar.
    preClose(done) {
      for (const client of this.websocketServer.clients) client.close(1001, 'Servidor reiniciando');
      // Em modo noServer o callback do close() pode não disparar; o padrão do plugin também não espera.
      this.websocketServer.close();
      done();
    },
  });
  await app.register(multipart, {
    limits: { fileSize: env.UPLOAD_MAX_FILE_MB * 1024 * 1024, files: 3, fields: 10 },
  });

  // ── Documentação ──
  if (env.SWAGGER_ENABLED) {
    await app.register(swagger, {
      openapi: {
        info: { title: 'Conecta Doações API', version: pkg.version },
        components: { securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE } } },
        security: [{ cookieAuth: [] }],
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      // "Try it out": o login pelo Swagger grava o cookie, e todo envio leva o header anti-CSRF.
      theme: {
        js: [
          {
            filename: 'csrf-header.js',
            content:
              'const f=window.fetch;window.fetch=(i,o={})=>{const h=new Headers(o.headers);' +
              "h.set('x-requested-with','XMLHttpRequest');return f(i,{...o,headers:h,credentials:'include'})};",
          },
        ],
      },
    });
  }

  // ── Rotas ──
  healthRoutes(app, createHealthController({ version: pkg.version, pingDb: (ms) => db.ping(ms) }));

  const mailer =
    opts.mailer ??
    (env.RESEND_API_KEY
      ? createResendMailer({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM })
      : createLogMailer(app.log));

  // Injeção de dependência sem container: repositories → services → controllers.
  const services = {
    auth: createAuthService({
      db,
      authRepo: authRepository,
      storage,
      hasher: bcryptHasher,
      signToken: (payload) => app.jwt.sign(payload),
    }),
    passwordReset: createPasswordResetService({
      db,
      authRepo: authRepository,
      resetsRepo: passwordResetsRepository,
      hasher: bcryptHasher,
      mailer,
      appUrl: env.APP_URL,
      onEmailError: (err) => app.log.error({ err }, 'Falha ao enviar e-mail de redefinição de senha'),
    }),
    admin: createAdminService({ db, adminRepo: adminRepository, storage }),
    items: createItemsService({ db, itemsRepo: itemsRepository, eventsRepo: itemEventsRepository, storage }),
    interests: createInterestsService({
      db,
      itemsRepo: itemsRepository,
      interestsRepo: interestsRepository,
      eventsRepo: itemEventsRepository,
    }),
    chats: createChatsService({
      db,
      itemsRepo: itemsRepository,
      chatsRepo: chatsRepository,
      eventsRepo: itemEventsRepository,
      bus,
    }),
    reports: createReportsService({
      db,
      itemsRepo: itemsRepository,
      reportsRepo: reportsRepository,
      eventsRepo: itemEventsRepository,
    }),
    profile: createProfileService({
      db,
      profileRepo: profileRepository,
      authRepo: authRepository,
      storage,
      hasher: bcryptHasher,
    }),
  };
  const users = createUsersService({ db, usersRepo: usersRepository, items: services.items });
  const maxFileBytes = env.UPLOAD_MAX_FILE_MB * 1024 * 1024;
  const controllers = {
    auth: createAuthController(services.auth, { maxFileBytes, passwordReset: services.passwordReset }),
    admin: createAdminController(services.admin),
    items: createItemsController(services.items, { maxFileBytes }),
    interests: createInterestsController(services.interests),
    chats: createChatsController(services.chats),
    reports: createReportsController(services.reports),
    profile: createProfileController(services.profile, { maxFileBytes }),
    users: createUsersController(users),
  };

  await app.register(
    async (api) => {
      authRoutes(api, controllers.auth);
      adminRoutes(api, controllers.admin);
      itemsRoutes(api, controllers.items);
      interestsRoutes(api, controllers.interests);
      chatsRoutes(api, controllers.chats);
      reportsRoutes(api, controllers.reports);
      profileRoutes(api, controllers.profile);
      usersRoutes(api, controllers.users);
      chatsWebsocket(api, {
        service: services.chats,
        bus,
        findAuthContext: (userId) => authRepository.findAuthContext(db.sql, userId),
        allowedOrigins,
      });
    },
    { prefix: '/api/v1' },
  );

  if (!opts.db) app.addHook('onClose', () => db.close());

  return app;
}
