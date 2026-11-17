import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
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
import { env, isProd } from './core/env';
import { AppError } from './core/errors';
import { errorPlugin } from './core/errors/handler';
import { bcryptHasher } from './core/passwords';
import { createMemoryBus, type RealtimeBus } from './core/realtime';
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
import { createInterestsController } from './modules/interests/interests.controller';
import { interestsRepository } from './modules/interests/interests.repository';
import { interestsRoutes } from './modules/interests/interests.routes';
import { createInterestsService } from './modules/interests/interests.service';
import { createProfileController } from './modules/profile/profile.controller';
import { profileRepository } from './modules/profile/profile.repository';
import { profileRoutes } from './modules/profile/profile.routes';
import { createProfileService } from './modules/profile/profile.service';
import { createHealthController } from './modules/health/health.controller';
import { itemEventsRepository } from './modules/items/item-events.repository';
import { createItemsController } from './modules/items/items.controller';
import { itemsRepository } from './modules/items/items.repository';
import { itemsRoutes } from './modules/items/items.routes';
import { createItemsService } from './modules/items/items.service';
import { healthRoutes } from './modules/health/health.routes';

export interface BuildAppOptions {
  /** Injetado nos testes; por padrão cria o pool a partir de DATABASE_URL. */
  db?: Db;
  /** Injetado nos testes (fake em memória); por padrão usa o Supabase Storage. */
  storage?: Storage;
  logger?: boolean;
  /** Barramento de eventos do chat; por padrão, em memória (1 instância). */
  bus?: RealtimeBus;
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
            redact: ['req.headers.authorization', 'req.body.password'],
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
    origin: isProd || env.NODE_ENV === 'test' ? env.CORS_ORIGIN : [...env.CORS_ORIGIN, 'http://localhost:5173'],
    credentials: false,
  });
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // req.ip pode faltar em sockets injetados (testes de WebSocket); sem fallback o plugin quebra.
    keyGenerator: (req) => req.ip || 'unknown',
    errorResponseBuilder: () => Object.assign(new AppError('TOO_MANY_REQUESTS'), { statusCode: 429 }),
  });
  await app.register(jwt, { secret: env.JWT_SECRET, sign: { expiresIn: env.JWT_EXPIRES_IN } });
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
        components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
        security: [{ bearerAuth: [] }],
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  // ── Rotas ──
  healthRoutes(app, createHealthController({ version: pkg.version, pingDb: (ms) => db.ping(ms) }));

  // Injeção de dependência sem container: repositories → services → controllers.
  const services = {
    auth: createAuthService({
      db,
      authRepo: authRepository,
      storage,
      hasher: bcryptHasher,
      signToken: (payload) => app.jwt.sign(payload),
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
    profile: createProfileService({
      db,
      profileRepo: profileRepository,
      authRepo: authRepository,
      storage,
      hasher: bcryptHasher,
    }),
  };
  const maxFileBytes = env.UPLOAD_MAX_FILE_MB * 1024 * 1024;
  const controllers = {
    auth: createAuthController(services.auth, { maxFileBytes }),
    admin: createAdminController(services.admin),
    items: createItemsController(services.items, { maxFileBytes }),
    interests: createInterestsController(services.interests),
    chats: createChatsController(services.chats),
    profile: createProfileController(services.profile, { maxFileBytes }),
  };

  await app.register(
    async (api) => {
      authRoutes(api, controllers.auth);
      adminRoutes(api, controllers.admin);
      itemsRoutes(api, controllers.items);
      interestsRoutes(api, controllers.interests);
      chatsRoutes(api, controllers.chats);
      profileRoutes(api, controllers.profile);
      chatsWebsocket(api, {
        service: services.chats,
        bus,
        findAuthContext: (userId) => authRepository.findAuthContext(db.sql, userId),
      });
    },
    { prefix: '/api/v1' },
  );

  if (!opts.db) app.addHook('onClose', () => db.close());

  return app;
}
