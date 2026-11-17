import { EventEmitter } from 'node:events';
import type { ChatMessage, ItemStatus, Role } from '../types';

/** Eventos de domínio do chat, publicados pelos services depois do commit. */
export type RealtimeEvent =
  | { type: 'message.created'; itemId: string; message: ChatMessage }
  | {
      type: 'item.status_changed';
      itemId: string;
      from: ItemStatus;
      to: ItemStatus;
      actorId: string;
      actorRole: Role;
      reason: string | null;
      completedAt: Date | null;
    };

export interface RealtimeBus {
  publish(event: RealtimeEvent): void;
  /** Ouve os eventos de um item. Devolve a função que cancela a inscrição. */
  subscribe(itemId: string, listener: (event: RealtimeEvent) => void): () => void;
}

/**
 * Barramento em memória: basta com 1 instância da API (o cenário do MVP).
 * Com mais instâncias, troca-se esta implementação por Redis ou Postgres LISTEN/NOTIFY
 * sem mexer nos services nem no gateway.
 */
export function createMemoryBus(): RealtimeBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const channel = (itemId: string) => `item:${itemId}`;

  return {
    publish(event) {
      emitter.emit(channel(event.itemId), event);
    },
    subscribe(itemId, listener) {
      emitter.on(channel(itemId), listener);
      return () => emitter.off(channel(itemId), listener);
    },
  };
}
