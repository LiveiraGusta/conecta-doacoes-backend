import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { issuedBeforePasswordChange, type JwtPayload } from '../../core/auth';
import { AppError } from '../../core/errors';
import type { RealtimeBus } from '../../core/realtime';
import type { AuthContext, AuthUser } from '../../types';
import { toWsEvent, WsClientMessage, type WsServerMessage } from './chats.dto';
import type { ChatsService } from './chats.service';

export interface ChatsWsDeps {
  service: Pick<ChatsService, 'authorizeSubscription'>;
  bus: RealtimeBus;
  findAuthContext(userId: string): Promise<AuthContext | null>;
  authTimeoutMs?: number;
  heartbeatMs?: number;
}

/** Códigos de fechamento (faixa 4000–4999 é da aplicação). */
export const WS_CLOSE = {
  AUTH_TIMEOUT: 4401,
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
} as const;

const MAX_SUBSCRIPTIONS = 50;

/**
 * Canal em tempo real do chat: complementa as rotas REST (que continuam sendo o contrato),
 * empurrando novas mensagens e mudanças de status das salas em que o usuário se inscreveu.
 *
 * Protocolo (JSON): o cliente conecta, envia {type:'auth', token} em até 5 s, recebe {type:'ready'}
 * e então {type:'subscribe', item_id} para cada sala. Detalhes em docs/specs/Spec do Chat em Tempo Real.md.
 */
export function chatsWebsocket(app: FastifyInstance, deps: ChatsWsDeps) {
  const authTimeoutMs = deps.authTimeoutMs ?? 5000;
  const heartbeatMs = deps.heartbeatMs ?? 30_000;

  app.get(
    '/chats/ws',
    {
      websocket: true,
      // Autenticação vem na 1ª mensagem: o navegador não envia Authorization no handshake.
      config: { public: true },
      schema: { hide: true },
    },
    (socket: WebSocket, req) => {
      let user: AuthUser | null = null;
      const subscriptions = new Map<string, () => void>();
      let alive = true;

      const send = (msg: WsServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      const sendError = (err: unknown, itemId?: string) => {
        const e = err instanceof AppError ? err : new AppError('INTERNAL_ERROR');
        if (!(err instanceof AppError)) req.log.error({ err }, 'erro no websocket do chat');
        send({ type: 'error', error: e.code, message: e.message, ...(itemId ? { item_id: itemId } : {}) });
      };
      const drop = (itemId: string) => {
        subscriptions.get(itemId)?.();
        subscriptions.delete(itemId);
      };

      const authTimer = setTimeout(() => {
        if (!user) socket.close(WS_CLOSE.AUTH_TIMEOUT, 'Autenticação não recebida a tempo');
      }, authTimeoutMs);

      // Derruba conexões mortas (sem pong) para não acumular inscrições.
      socket.on('pong', () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!alive) return socket.terminate();
        alive = false;
        socket.ping();
      }, heartbeatMs);

      socket.on('close', () => {
        clearTimeout(authTimer);
        clearInterval(heartbeat);
        for (const itemId of [...subscriptions.keys()]) drop(itemId);
      });

      async function authenticate(token: string) {
        let payload: JwtPayload;
        try {
          payload = app.jwt.verify<JwtPayload>(token);
        } catch {
          return socket.close(WS_CLOSE.UNAUTHORIZED, 'Token inválido');
        }
        const ctx = await deps.findAuthContext(payload.sub);
        if (!ctx || issuedBeforePasswordChange(payload.iat, ctx.passwordChangedAt)) {
          return socket.close(WS_CLOSE.UNAUTHORIZED, 'Token inválido');
        }
        if (ctx.role !== 'DONOR' && ctx.role !== 'NGO') return socket.close(WS_CLOSE.FORBIDDEN, 'Perfil sem chat');
        const { passwordChangedAt: _ignored, ...current } = ctx;
        user = current;
        clearTimeout(authTimer);
        send({ type: 'ready', user_id: ctx.id });
      }

      async function subscribe(current: AuthUser, itemId: string) {
        if (subscriptions.has(itemId)) return send({ type: 'subscribed', item_id: itemId });
        if (subscriptions.size >= MAX_SUBSCRIPTIONS) {
          return sendError(new AppError('VALIDATION_ERROR', `Limite de ${MAX_SUBSCRIPTIONS} salas por conexão.`), itemId);
        }
        await deps.service.authorizeSubscription(current, itemId);
        if (socket.readyState !== socket.OPEN || subscriptions.has(itemId)) return;

        const unsubscribe = deps.bus.subscribe(itemId, (event) => {
          send(toWsEvent(event));
          // Cancelou: a negociação acabou e a sala fecha para os dois lados.
          if (event.type === 'item.status_changed' && event.to === 'DISPONIVEL') {
            drop(itemId);
            send({ type: 'unsubscribed', item_id: itemId, reason: 'chat_closed' });
          }
        });
        subscriptions.set(itemId, unsubscribe);
        send({ type: 'subscribed', item_id: itemId });
      }

      socket.on('message', async (raw) => {
        let parsed: ReturnType<typeof WsClientMessage.safeParse>;
        try {
          parsed = WsClientMessage.safeParse(JSON.parse(raw.toString()));
        } catch {
          return sendError(new AppError('VALIDATION_ERROR', 'Mensagem não é JSON válido.'));
        }
        if (!parsed.success) return sendError(new AppError('VALIDATION_ERROR', 'Mensagem fora do protocolo.'));
        const msg = parsed.data;

        if (!user) {
          if (msg.type !== 'auth') return socket.close(WS_CLOSE.UNAUTHORIZED, 'Envie {type:"auth"} primeiro');
          return authenticate(msg.token).catch((err) => sendError(err));
        }

        switch (msg.type) {
          case 'auth':
            return send({ type: 'ready', user_id: user.id });
          case 'ping':
            return send({ type: 'pong' });
          case 'unsubscribe':
            drop(msg.item_id);
            return send({ type: 'unsubscribed', item_id: msg.item_id, reason: 'requested' });
          case 'subscribe':
            return subscribe(user, msg.item_id).catch((err) => sendError(err, msg.item_id));
        }
      });
    },
  );
}
