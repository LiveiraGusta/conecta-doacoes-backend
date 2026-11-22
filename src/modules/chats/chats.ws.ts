import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { issuedBeforePasswordChange, type JwtPayload } from '../../core/auth';
import { AppError } from '../../core/errors';
import { SESSION_COOKIE } from '../../core/session-cookie';
import type { RealtimeBus } from '../../core/realtime';
import type { AuthContext, AuthUser } from '../../types';
import { toWsEvent, WsClientMessage, type WsServerMessage } from './chats.dto';
import type { ChatsService } from './chats.service';

export interface ChatsWsDeps {
  service: Pick<ChatsService, 'authorizeSubscription' | 'unread'>;
  bus: RealtimeBus;
  findAuthContext(userId: string): Promise<AuthContext | null>;
  /** Origens do frontend aceitas no handshake (as mesmas do CORS). */
  allowedOrigins: string[];
  heartbeatMs?: number;
}

/** Códigos de fechamento (faixa 4000–4999 é da aplicação). */
export const WS_CLOSE = {
  /** Sem cookie de sessão, token inválido/expirado ou usuário que não existe mais. */
  UNAUTHORIZED: 4401,
  /** ADMIN (sem chat) ou Origin fora da lista: o cliente não deve reconectar. */
  FORBIDDEN: 4403,
} as const;

const MAX_SUBSCRIPTIONS = 50;

/**
 * Canal em tempo real do chat: complementa as rotas REST (que continuam sendo o contrato),
 * empurrando novas mensagens e mudanças de status das salas em que o usuário se inscreveu.
 *
 * Protocolo (JSON): o navegador conecta levando o cookie de sessão (ADR-13). O servidor confere o Origin
 * e o cookie no handshake, responde {type:'ready'} e o cliente manda {type:'subscribe', item_id} para cada sala.
 * Detalhes em docs/specs/Spec do Chat em Tempo Real — WebSocket.md.
 */
export function chatsWebsocket(app: FastifyInstance, deps: ChatsWsDeps) {
  const heartbeatMs = deps.heartbeatMs ?? 30_000;

  app.get(
    '/chats/ws',
    {
      websocket: true,
      // Pública para o hook global: um 401 no upgrade chegaria ao navegador como 1006, sem motivo.
      // A sessão é conferida aqui dentro, e a falha fecha com 4401/4403.
      config: { public: true },
      schema: { hide: true },
    },
    (socket: WebSocket, req) => {
      const subscriptions = new Map<string, () => void>();
      // Canal do próprio usuário (não lidas): vale para todas as conversas, inscritas ou não.
      let unsubscribeUser: (() => void) | null = null;
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
        clearInterval(heartbeat);
        for (const itemId of [...subscriptions.keys()]) drop(itemId);
        unsubscribeUser?.();
      });

      const reject = (code: number, reason: string) => {
        socket.close(code, reason);
        return null;
      };

      /** Confere Origin (anti cross-site WebSocket hijacking) e o cookie de sessão, uma vez, no handshake. */
      async function authenticate(): Promise<AuthUser | null> {
        const origin = req.headers.origin;
        if (!origin || !deps.allowedOrigins.includes(origin)) return reject(WS_CLOSE.FORBIDDEN, 'Origem não permitida');

        const token = req.cookies?.[SESSION_COOKIE];
        if (!token) return reject(WS_CLOSE.UNAUTHORIZED, 'Sessão ausente');
        let payload: JwtPayload;
        try {
          payload = app.jwt.verify<JwtPayload>(token);
        } catch {
          return reject(WS_CLOSE.UNAUTHORIZED, 'Sessão inválida');
        }
        const ctx = await deps.findAuthContext(payload.sub);
        if (!ctx || issuedBeforePasswordChange(payload.iat, ctx.passwordChangedAt)) {
          return reject(WS_CLOSE.UNAUTHORIZED, 'Sessão inválida');
        }
        if (ctx.role !== 'DONOR' && ctx.role !== 'NGO') return reject(WS_CLOSE.FORBIDDEN, 'Perfil sem chat');
        const { passwordChangedAt: _ignored, ...current } = ctx;
        if (socket.readyState !== socket.OPEN) return null;
        unsubscribeUser = deps.bus.subscribeUser(current.id, (event) => {
          deps.service
            .unread(current, event.itemId)
            .then((u) =>
              send({
                type: 'unread.updated',
                item_id: event.itemId,
                unread_count: u.item_unread,
                unread_messages: u.unread_messages,
                unread_chats: u.unread_chats,
              }),
            )
            .catch((err) => sendError(err, event.itemId));
        });
        send({ type: 'ready', user_id: ctx.id });
        return current;
      }

      const authReady = authenticate().catch((err) => {
        sendError(err);
        return reject(WS_CLOSE.UNAUTHORIZED, 'Falha ao autenticar');
      });

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

        // Mensagens que chegarem antes do `ready` esperam a autenticação do handshake.
        const current = await authReady;
        if (!current) return;

        switch (msg.type) {
          case 'ping':
            return send({ type: 'pong' });
          case 'unsubscribe':
            drop(msg.item_id);
            return send({ type: 'unsubscribed', item_id: msg.item_id, reason: 'requested' });
          case 'subscribe':
            return subscribe(current, msg.item_id).catch((err) => sendError(err, msg.item_id));
        }
      });
    },
  );
}
