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

export async function openWs(app: FastifyInstance, path = '/api/v1/chats/ws'): Promise<TestWs> {
  const ws = await app.injectWS(path);
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
