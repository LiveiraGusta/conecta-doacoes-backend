import { z } from 'zod';
import { isoDate, optionalText, PaginationQuery, text, toIso, toIsoOrNull } from '../../core/dto';
import type { RealtimeEvent } from '../../core/realtime';
import type { ChatMessage, ChatSummary, Counterpart, Item, Role } from '../../types';

// ── Entrada ──
export const ChatListQuery = PaginationQuery.extend({
  status: z.enum(['EM_PROGRESSO', 'DOADO']).optional(),
});
export type ChatListQuery = z.infer<typeof ChatListQuery>;

export const MessagesQuery = z.object({
  /** Polling incremental: só mensagens criadas depois deste instante. */
  after: z.iso.datetime({ offset: true }).optional(),
});
export type MessagesQuery = z.infer<typeof MessagesQuery>;

export const SendMessageBody = z.object({ message: text(1, 2000) });
export type SendMessageBody = z.infer<typeof SendMessageBody>;

// Sem corpo, o Fastify entrega null (não undefined): por isso nullish.
export const CancelBody = z.object({ reason: optionalText(500) }).nullish();
export type CancelBody = z.infer<typeof CancelBody>;

// ── Saída ──
const PartyRole = z.enum(['DONOR', 'NGO']);

export const CounterpartDto = z.object({ id: z.uuid(), name: z.string(), role: PartyRole }).describe('Counterpart');
export type CounterpartDto = z.infer<typeof CounterpartDto>;

export const MessageDto = z
  .object({
    id: z.uuid(),
    item_id: z.uuid(),
    sender_id: z.uuid(),
    receiver_id: z.uuid(),
    message: z.string(),
    created_at: isoDate(),
  })
  .describe('Message');
export type MessageDto = z.infer<typeof MessageDto>;

export const ChatSummaryDto = z
  .object({
    item_id: z.uuid(),
    item_title: z.string(),
    item_photo: z.string(),
    item_status: z.enum(['EM_PROGRESSO', 'DOADO']),
    counterpart: CounterpartDto,
    last_message: z
      .object({ message: z.string(), sender_id: z.uuid(), created_at: isoDate() })
      .nullable(),
  })
  .describe('ChatSummary');

export const ChatListDto = z.object({ total: z.number().int().min(0), data: z.array(ChatSummaryDto) });
export type ChatListDto = z.infer<typeof ChatListDto>;

export const ChatRoomDto = z
  .object({
    item: z.object({
      id: z.uuid(),
      title: z.string(),
      status: z.enum(['EM_PROGRESSO', 'DOADO']),
      donor_id: z.uuid(),
      selected_ngo_id: z.uuid().nullable(),
    }),
    counterpart: CounterpartDto,
    messages: z.array(MessageDto),
  })
  .describe('ChatRoom');
export type ChatRoomDto = z.infer<typeof ChatRoomDto>;

export const ConfirmResultDto = z.object({
  item_id: z.uuid(),
  status: z.literal('DOADO'),
  completed_at: isoDate(),
});
export type ConfirmResultDto = z.infer<typeof ConfirmResultDto>;

export const CancelResultDto = z.object({
  item_id: z.uuid(),
  previous_status: z.literal('EM_PROGRESSO'),
  current_status: z.literal('DISPONIVEL'),
  cancelled_by: PartyRole,
  message: z.string(),
});
export type CancelResultDto = z.infer<typeof CancelResultDto>;

// ── Mapeamento ──
const party = (role: Role) => role as z.infer<typeof PartyRole>;

export const toMessageDto = (m: ChatMessage): MessageDto => ({
  id: m.id,
  item_id: m.item_id,
  sender_id: m.sender_id,
  receiver_id: m.receiver_id,
  message: m.message,
  created_at: toIso(m.created_at),
});

export const toChatListDto = (page: { total: number; rows: ChatSummary[] }): ChatListDto => ({
  total: page.total,
  data: page.rows.map((r) => ({
    item_id: r.item_id,
    item_title: r.item_title,
    item_photo: r.item_photo,
    item_status: r.item_status,
    counterpart: { id: r.counterpart_id, name: r.counterpart_name, role: party(r.counterpart_role) },
    last_message:
      r.last_message !== null && r.last_sender_id && r.last_created_at
        ? { message: r.last_message, sender_id: r.last_sender_id, created_at: toIso(r.last_created_at) }
        : null,
  })),
});

export const toChatRoomDto = (r: { item: Item; counterpart: Counterpart; messages: ChatMessage[] }): ChatRoomDto => ({
  item: {
    id: r.item.id,
    title: r.item.title,
    status: r.item.status as ChatRoomDto['item']['status'],
    donor_id: r.item.donor_id,
    selected_ngo_id: r.item.selected_ngo_id,
  },
  counterpart: { id: r.counterpart.id, name: r.counterpart.name, role: party(r.counterpart.role) },
  messages: r.messages.map(toMessageDto),
});

export const toConfirmResultDto = (item: Item): ConfirmResultDto => ({
  item_id: item.id,
  status: 'DOADO',
  completed_at: toIso(item.completed_at!),
});

export const toCancelResultDto = (r: { item: Item; cancelledBy: Role }): CancelResultDto => ({
  item_id: r.item.id,
  previous_status: 'EM_PROGRESSO',
  current_status: 'DISPONIVEL',
  cancelled_by: party(r.cancelledBy),
  message: 'Negociação cancelada. O item voltou para a vitrine.',
});

// ── WebSocket: mensagens no fio ──
export const WsClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(1) }),
  z.object({ type: z.literal('subscribe'), item_id: z.uuid() }),
  z.object({ type: z.literal('unsubscribe'), item_id: z.uuid() }),
  z.object({ type: z.literal('ping') }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessage>;

export type WsServerMessage =
  | { type: 'ready'; user_id: string }
  | { type: 'subscribed'; item_id: string }
  | { type: 'unsubscribed'; item_id: string; reason: 'requested' | 'chat_closed' }
  | { type: 'pong' }
  | { type: 'error'; error: string; message: string; item_id?: string }
  | { type: 'message.created'; item_id: string; message: MessageDto }
  | {
      type: 'item.status_changed';
      item_id: string;
      previous_status: string;
      status: string;
      changed_by: 'DONOR' | 'NGO';
      reason: string | null;
      completed_at: string | null;
    };

export const toWsEvent = (e: RealtimeEvent): WsServerMessage =>
  e.type === 'message.created'
    ? { type: 'message.created', item_id: e.itemId, message: toMessageDto(e.message) }
    : {
        type: 'item.status_changed',
        item_id: e.itemId,
        previous_status: e.from,
        status: e.to,
        changed_by: party(e.actorRole),
        reason: e.reason,
        completed_at: toIsoOrNull(e.completedAt),
      };
