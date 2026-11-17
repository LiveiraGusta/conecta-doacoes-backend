import { EventEmitter } from 'node:events';
import type { ChatMessage, ItemStatus, Role } from '../types';

/** Eventos de domínio de uma sala (item), publicados pelos services depois do commit. */
export type RoomEvent =
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

/** Eventos de um usuário, entregues em todas as conexões dele, inscritas ou não na sala. */
export type UserEvent = { type: 'unread.changed'; userId: string; itemId: string };

export type RealtimeEvent = RoomEvent | UserEvent;

export interface RealtimeBus {
  publish(event: RealtimeEvent): void;
  /** Ouve os eventos de um item. Devolve a função que cancela a inscrição. */
  subscribe(itemId: string, listener: (event: RoomEvent) => void): () => void;
  /** Ouve os eventos de um usuário. Devolve a função que cancela a inscrição. */
  subscribeUser(userId: string, listener: (event: UserEvent) => void): () => void;
}

/**
 * Barramento em memória: basta com 1 instância da API (o cenário do MVP).
 * Com mais instâncias, troca-se esta implementação por Redis ou Postgres LISTEN/NOTIFY
 * sem mexer nos services nem no gateway.
 */
export function createMemoryBus(): RealtimeBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const itemChannel = (itemId: string) => `item:${itemId}`;
  const userChannel = (userId: string) => `user:${userId}`;

  return {
    publish(event) {
      emitter.emit(event.type === 'unread.changed' ? userChannel(event.userId) : itemChannel(event.itemId), event);
    },
    subscribe(itemId, listener) {
      emitter.on(itemChannel(itemId), listener);
      return () => emitter.off(itemChannel(itemId), listener);
    },
    subscribeUser(userId, listener) {
      emitter.on(userChannel(userId), listener);
      return () => emitter.off(userChannel(userId), listener);
    },
  };
}
