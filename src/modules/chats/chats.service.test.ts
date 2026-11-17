import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../test/helpers/fake-db';
import type { RealtimeEvent } from '../../core/realtime';
import type { AuthUser, ChatMessage, Item } from '../../types';
import type { ChatsRepository } from './chats.repository';
import { createChatsService, type ChatsDeps } from './chats.service';

const DONOR: AuthUser = { id: 'd1', role: 'DONOR', city: 'São Paulo', state: 'SP', ngoStatus: null };
const NGO: AuthUser = { id: 'n1', role: 'NGO', city: 'São Paulo', state: 'SP', ngoStatus: 'ATIVO' };
const OTHER_NGO: AuthUser = { ...NGO, id: 'n2' };

const item = (over: Partial<Item> = {}): Item => ({
  id: 'i1',
  donor_id: DONOR.id,
  title: 'Casaco',
  description: null,
  category: 'ROUPAS',
  city: 'São Paulo',
  state: 'SP',
  status: 'EM_PROGRESSO',
  selected_ngo_id: NGO.id,
  created_at: new Date(),
  completed_at: null,
  ...over,
});

const MSG: ChatMessage = {
  id: 'm1',
  item_id: 'i1',
  sender_id: DONOR.id,
  receiver_id: NGO.id,
  message: 'Oi',
  created_at: new Date(),
};

function setup(over: { itemsRepo?: Partial<ChatsDeps['itemsRepo']>; chatsRepo?: Partial<ChatsRepository> } = {}) {
  const published: RealtimeEvent[] = [];
  const eventsRepo = { insert: vi.fn(async () => {}) };
  const service = createChatsService({
    db: fakeDb(),
    itemsRepo: {
      findById: async (): Promise<Item | null> => item(),
      confirmIfInProgress: async () => null,
      cancelIfInProgress: async () => null,
      ...over.itemsRepo,
    },
    chatsRepo: {
      listForUser: async () => ({ total: 0, rows: [] }),
      listPairMessages: async () => [],
      insertIfOpen: async () => null,
      findCounterpart: async (_q: unknown, id: string) => ({ id, name: 'Fulano', role: 'NGO' as const }),
      markRead: async () => {},
      unreadSummary: async () => ({ unread_messages: 0, unread_chats: 0, item_unread: 0 }),
      ...over.chatsRepo,
    } as ChatsRepository,
    eventsRepo,
    bus: { publish: (e) => published.push(e), subscribe: () => () => {}, subscribeUser: () => () => {} },
  });
  return { service, published, eventsRepo };
}

const notFound = { itemsRepo: { findById: async (): Promise<Item | null> => null } };
const disponivel = { itemsRepo: { findById: async (): Promise<Item | null> => item({ status: 'DISPONIVEL', selected_ngo_id: null }) } };

describe('chatsService.room', () => {
  it('lê só as mensagens do par atual e devolve a outra parte como contraparte', async () => {
    const listPairMessages = vi.fn(async () => [MSG]);
    const { service } = setup({ chatsRepo: { listPairMessages } });
    const after = new Date('2026-11-16T10:00:00Z');
    const room = await service.room(NGO, 'i1', after);
    expect(listPairMessages).toHaveBeenCalledWith(expect.anything(), { itemId: 'i1', donorId: DONOR.id, ngoId: NGO.id, after });
    expect(room.counterpart.id).toBe(DONOR.id);
  });

  it.each([
    ['ITEM_NOT_FOUND', 404, DONOR, notFound],
    ['CHAT_CLOSED', 409, DONOR, disponivel],
    ['FORBIDDEN', 403, NGO, disponivel],
    ['FORBIDDEN', 403, OTHER_NGO, {}],
  ] as const)('%s (%i)', async (code, status, user, over) => {
    await expect(setup(over).service.room(user, 'i1')).rejects.toMatchObject({ code, status });
  });

  it('item DOADO continua legível', async () => {
    const { service } = setup({ itemsRepo: { findById: async () => item({ status: 'DOADO' }) } });
    await expect(service.room(DONOR, 'i1')).resolves.toMatchObject({ item: { status: 'DOADO' } });
  });
});

describe('chatsService.send', () => {
  it('grava, marca como lido para quem enviou e avisa as duas partes', async () => {
    const markRead = vi.fn(async () => {});
    const { service, published } = setup({ chatsRepo: { insertIfOpen: async () => MSG, markRead } });
    await expect(service.send(DONOR, 'i1', 'Oi')).resolves.toBe(MSG);
    expect(markRead).toHaveBeenCalledWith(expect.anything(), DONOR.id, 'i1');
    expect(published).toEqual([
      { type: 'message.created', itemId: 'i1', message: MSG },
      { type: 'unread.changed', userId: NGO.id, itemId: 'i1' },
      { type: 'unread.changed', userId: DONOR.id, itemId: 'i1' },
    ]);
  });

  it.each([
    ['ITEM_NOT_FOUND', DONOR, notFound],
    ['FORBIDDEN', OTHER_NGO, {}],
    ['CHAT_CLOSED', DONOR, disponivel],
    ['CHAT_CLOSED', DONOR, { itemsRepo: { findById: async (): Promise<Item | null> => item({ status: 'DOADO' }) } }],
  ] as const)('%s sem gravar nem publicar', async (code, user, over) => {
    const { service, published } = setup(over);
    await expect(service.send(user, 'i1', 'Oi')).rejects.toMatchObject({ code });
    expect(published).toEqual([]);
  });
});

describe('chatsService.confirmReceipt', () => {
  it('grava o evento EM_PROGRESSO → DOADO e publica com completed_at', async () => {
    const done = item({ status: 'DOADO', completed_at: new Date() });
    const { service, published, eventsRepo } = setup({ itemsRepo: { confirmIfInProgress: async () => done } });
    await service.confirmReceipt(NGO, 'i1');
    expect(eventsRepo.insert).toHaveBeenCalledWith(expect.anything(), {
      itemId: 'i1',
      from: 'EM_PROGRESSO',
      to: 'DOADO',
      actorId: NGO.id,
      ngoId: NGO.id,
    });
    expect(published[0]).toMatchObject({ type: 'item.status_changed', to: 'DOADO', completedAt: done.completed_at });
  });

  it.each([
    ['ITEM_NOT_FOUND', 404, NGO, notFound],
    ['FORBIDDEN', 403, OTHER_NGO, {}],
    ['ITEM_NOT_IN_PROGRESS', 409, NGO, { itemsRepo: { findById: async (): Promise<Item | null> => item({ status: 'DOADO' }) } }],
  ] as const)('%s', async (code, status, user, over) => {
    const { service, published } = setup(over);
    await expect(service.confirmReceipt(user, 'i1')).rejects.toMatchObject({ code, status });
    expect(published).toEqual([]);
  });
});

describe('chatsService.cancel', () => {
  it('grava 2 eventos com o motivo e publica a volta para DISPONIVEL', async () => {
    const back = { ...item({ status: 'DISPONIVEL', selected_ngo_id: null }), previous_ngo_id: NGO.id };
    const { service, published, eventsRepo } = setup({ itemsRepo: { cancelIfInProgress: async () => back } });
    const result = await service.cancel(NGO, 'i1', 'Não consigo buscar');
    expect(result.cancelledBy).toBe('NGO');
    expect(eventsRepo.insert).toHaveBeenCalledWith(expect.anything(), [
      { itemId: 'i1', actorId: NGO.id, ngoId: NGO.id, reason: 'Não consigo buscar', from: 'EM_PROGRESSO', to: 'CANCELADO' },
      { itemId: 'i1', actorId: NGO.id, ngoId: NGO.id, reason: 'Não consigo buscar', from: 'CANCELADO', to: 'DISPONIVEL' },
    ]);
    expect(published[0]).toMatchObject({ type: 'item.status_changed', from: 'EM_PROGRESSO', to: 'DISPONIVEL', actorRole: 'NGO' });
  });

  it.each([
    ['ITEM_NOT_FOUND', 404, DONOR, notFound],
    ['FORBIDDEN', 403, OTHER_NGO, {}],
    ['ITEM_NOT_IN_PROGRESS', 409, DONOR, disponivel],
  ] as const)('%s', async (code, status, user, over) => {
    await expect(setup(over).service.cancel(user, 'i1')).rejects.toMatchObject({ code, status });
  });
});
