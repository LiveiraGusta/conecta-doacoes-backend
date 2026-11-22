import type { Db, Queryable } from '../../core/db';
import { AppError } from '../../core/errors';
import type { RealtimeBus } from '../../core/realtime';
import type { AuthUser, ChatMessage, ChatSummary, Counterpart, Item, Page, Role, UnreadSummary } from '../../types';
import type { ItemEventsRepository } from '../items/item-events.repository';
import type { ItemsRepository } from '../items/items.repository';
import { noopNotifier, type Notifier } from '../notifications/notifications.service';
import type { ChatsRepository } from './chats.repository';

export interface ChatsDeps {
  db: Pick<Db, 'sql' | 'tx'>;
  itemsRepo: Pick<ItemsRepository, 'findById' | 'confirmIfInProgress' | 'cancelIfInProgress'>;
  chatsRepo: ChatsRepository;
  eventsRepo: Pick<ItemEventsRepository, 'insert'>;
  bus: RealtimeBus;
  /** E-mail de cancelamento (para a outra parte) e de doação concluída (para o doador). Mensagens não geram e-mail. */
  notifier?: Notifier;
}

export interface ChatRoom {
  item: Item;
  counterpart: Counterpart;
  messages: ChatMessage[];
}

export const createChatsService = ({ db, itemsRepo, chatsRepo, eventsRepo, bus, notifier = noopNotifier }: ChatsDeps) => {
  /**
   * Carrega o item e confirma que o usuário é parte da negociação atual.
   * 404 se não existe; com o item DISPONIVEL, o doador recebe CHAT_CLOSED e os demais 403.
   */
  async function participation(q: Queryable, user: AuthUser, itemId: string): Promise<Item> {
    const item = await itemsRepo.findById(q, itemId);
    if (!item) throw new AppError('ITEM_NOT_FOUND');
    if (item.status === 'DISPONIVEL') {
      if (user.id === item.donor_id) throw new AppError('CHAT_CLOSED');
      throw new AppError('FORBIDDEN');
    }
    if (user.id !== item.donor_id && user.id !== item.selected_ngo_id) {
      throw new AppError('FORBIDDEN', 'Você não participa desta negociação.');
    }
    return item;
  }

  const otherParty = (item: Item, userId: string) => (userId === item.donor_id ? item.selected_ngo_id! : item.donor_id);

  return {
    list(user: AuthUser, f: { status?: 'EM_PROGRESSO' | 'DOADO'; limit: number; offset: number }): Promise<Page<ChatSummary>> {
      return chatsRepo.listForUser(db.sql, { userId: user.id, ...f });
    },

    /** Item, contraparte e mensagens do par atual. Item DOADO é só leitura. */
    async room(user: AuthUser, itemId: string, after?: Date): Promise<ChatRoom> {
      const item = await participation(db.sql, user, itemId);
      const [counterpart, messages] = await Promise.all([
        chatsRepo.findCounterpart(db.sql, otherParty(item, user.id)),
        chatsRepo.listPairMessages(db.sql, { itemId, donorId: item.donor_id, ngoId: item.selected_ngo_id!, after }),
      ]);
      return { item, counterpart: counterpart!, messages };
    },

    /** Mesmas regras de leitura da sala; usado pelo WebSocket antes de inscrever o socket. */
    async authorizeSubscription(user: AuthUser, itemId: string): Promise<void> {
      await participation(db.sql, user, itemId);
    },

    async send(user: AuthUser, itemId: string, text: string): Promise<ChatMessage> {
      const message = await chatsRepo.insertIfOpen(db.sql, { itemId, senderId: user.id, message: text });
      if (!message) {
        // Escolhe o erro: 404/403 pela participação; fora isso a sala não aceita envio
        // (item DOADO, ou cancelado entre o INSERT e esta leitura).
        await participation(db.sql, user, itemId);
        throw new AppError('CHAT_CLOSED');
      }
      // Quem responde já leu o que recebeu.
      await chatsRepo.markRead(db.sql, user.id, itemId);
      bus.publish({ type: 'message.created', itemId, message });
      bus.publish({ type: 'unread.changed', userId: message.receiver_id, itemId });
      bus.publish({ type: 'unread.changed', userId: user.id, itemId });
      return message;
    },

    /** Totais para o badge; com itemId, inclui a contagem daquela conversa (usado pelo WebSocket). */
    unread(user: Pick<AuthUser, 'id'>, itemId?: string): Promise<UnreadSummary & { item_unread: number }> {
      return chatsRepo.unreadSummary(db.sql, user.id, itemId);
    },

    /** Marca a conversa como lida (mesmas regras de acesso da leitura da sala) e devolve os totais. */
    async markRead(user: AuthUser, itemId: string): Promise<UnreadSummary> {
      await participation(db.sql, user, itemId);
      await chatsRepo.markRead(db.sql, user.id, itemId);
      // As outras abas/aparelhos do usuário atualizam o badge.
      bus.publish({ type: 'unread.changed', userId: user.id, itemId });
      const { unread_messages, unread_chats } = await chatsRepo.unreadSummary(db.sql, user.id);
      return { unread_messages, unread_chats };
    },

    /** EM_PROGRESSO → DOADO pela ONG selecionada (a rota já exige ONG ATIVO). */
    async confirmReceipt(ngo: AuthUser, itemId: string): Promise<Item> {
      const item = await db.tx(async (tx) => {
        const updated = await itemsRepo.confirmIfInProgress(tx, itemId, ngo.id);
        if (updated) {
          await eventsRepo.insert(tx, { itemId, from: 'EM_PROGRESSO', to: 'DOADO', actorId: ngo.id, ngoId: ngo.id });
          return updated;
        }
        const current = await itemsRepo.findById(tx, itemId);
        if (!current) throw new AppError('ITEM_NOT_FOUND');
        if (current.selected_ngo_id !== ngo.id) throw new AppError('FORBIDDEN', 'Apenas a ONG escolhida confirma o recebimento.');
        throw new AppError('ITEM_NOT_IN_PROGRESS');
      });

      bus.publish({
        type: 'item.status_changed',
        itemId,
        from: 'EM_PROGRESSO',
        to: 'DOADO',
        actorId: ngo.id,
        actorRole: 'NGO',
        reason: null,
        completedAt: item.completed_at,
      });
      notifier.notify({ type: 'donation.completed', itemId, ngoId: ngo.id });
      return item;
    },

    /**
     * EM_PROGRESSO → DISPONIVEL pelo doador ou pela ONG selecionada (mesmo que rejeitada depois).
     * Grava dois eventos: EM_PROGRESSO → CANCELADO e CANCELADO → DISPONIVEL.
     */
    async cancel(user: AuthUser, itemId: string, reason?: string): Promise<{ item: Item; cancelledBy: Role }> {
      const item = await db.tx(async (tx) => {
        const updated = await itemsRepo.cancelIfInProgress(tx, itemId, user.id);
        if (updated) {
          const base = { itemId, actorId: user.id, ngoId: updated.previous_ngo_id, reason: reason ?? null };
          await eventsRepo.insert(tx, [
            { ...base, from: 'EM_PROGRESSO', to: 'CANCELADO' },
            { ...base, from: 'CANCELADO', to: 'DISPONIVEL' },
          ]);
          return updated;
        }
        const current = await itemsRepo.findById(tx, itemId);
        if (!current) throw new AppError('ITEM_NOT_FOUND');
        if (current.donor_id !== user.id && current.selected_ngo_id !== user.id) {
          throw new AppError('FORBIDDEN', 'Apenas o doador ou a ONG escolhida podem cancelar.');
        }
        throw new AppError('ITEM_NOT_IN_PROGRESS');
      });

      bus.publish({
        type: 'item.status_changed',
        itemId,
        from: 'EM_PROGRESSO',
        to: 'DISPONIVEL',
        actorId: user.id,
        actorRole: user.role,
        reason: reason ?? null,
        completedAt: null,
      });
      // Avisa a outra parte: a ONG que negociava, se quem cancelou foi o doador, ou o doador.
      const counterpartId = user.id === item.donor_id ? item.previous_ngo_id : item.donor_id;
      if (counterpartId) {
        notifier.notify({ type: 'negotiation.cancelled', itemId, actorId: user.id, counterpartId, reason: reason ?? null });
      }
      return { item, cancelledBy: user.role };
    },
  };
};

export type ChatsService = ReturnType<typeof createChatsService>;
