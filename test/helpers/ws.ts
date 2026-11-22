import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

type Msg = Record<string, unknown> & { type: string };

export interface TestWs {
  ws: WebSocket;
  inbox: Msg[];
  send(msg: unknown): void;
  /** Espera a próxima mensagem (ainda não consumida) que satisfaz o predicado. */
  next(match?: Partial<Msg> | ((m: Msg) => boolean), timeoutMs?: number): Promise<Msg>;
  /** Espera o fechamento e devolve o código. */
  closed(timeoutMs?: number): Promise<{ code: number; reason: string }>;
  close(): void;
}

const matches = (m: Msg, match?: Partial<Msg> | ((m: Msg) => boolean)) =>
  !match ? true : typeof match === 'function' ? match(m) : Object.entries(match).every(([k, v]) => m[k] === v);

export interface OpenWsOptions {
  /** Cabeçalho `cookie` do handshake (use `sessionCookie(token)`). Sem ele, a conexão fecha com 4401. */
  cookie?: string;
  /** Origin do handshake. Padrão: a origem do frontend liberada no .env.test. `null` = sem Origin. */
  origin?: string | null;
  path?: string;
}

export const TEST_ORIGIN = 'http://localhost:5173';

export async function openWs(app: FastifyInstance, opts: OpenWsOptions = {}): Promise<TestWs> {
  const origin = opts.origin === undefined ? TEST_ORIGIN : opts.origin;
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  if (opts.cookie) headers.cookie = opts.cookie;
  const ws = await app.injectWS(opts.path ?? '/api/v1/chats/ws', { headers });
  const inbox: Msg[] = [];
  const consumed = new Set<Msg>();
  let waiters: (() => void)[] = [];
  let closeInfo: { code: number; reason: string } | null = null;

  ws.on('message', (data) => {
    inbox.push(JSON.parse(data.toString()) as Msg);
    waiters.forEach((w) => w());
  });
  ws.on('close', (code, reason) => {
    closeInfo = { code, reason: reason.toString() };
    waiters.forEach((w) => w());
  });

  const waitFor = <T>(check: () => T | undefined, timeoutMs: number, what: string) =>
    new Promise<T>((resolve, reject) => {
      const tryNow = () => {
        const found = check();
        if (found !== undefined) {
          clearTimeout(timer);
          waiters = waiters.filter((w) => w !== tryNow);
          resolve(found);
        }
      };
      const timer = setTimeout(() => {
        waiters = waiters.filter((w) => w !== tryNow);
        reject(new Error(`WS: timeout esperando ${what}. Recebido: ${JSON.stringify(inbox)}`));
      }, timeoutMs);
      waiters.push(tryNow);
      tryNow();
    });

  return {
    ws,
    inbox,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (match, timeoutMs = 2000) =>
      waitFor(
        () => {
          const m = inbox.find((x) => !consumed.has(x) && matches(x, match));
          if (m) consumed.add(m);
          return m;
        },
        timeoutMs,
        JSON.stringify(typeof match === 'function' ? 'predicado' : match),
      ),
    closed: (timeoutMs = 2000) => waitFor(() => closeInfo ?? undefined, timeoutMs, 'fechamento'),
    close: () => ws.terminate(),
  };
}
