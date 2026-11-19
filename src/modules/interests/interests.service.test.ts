import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../test/helpers/fake-db';
import type { AuthUser, Item } from '../../types';
import type { InterestsDeps } from './interests.service';
import { createInterestsService } from './interests.service';

const DONOR = 'd1';
const NGO = 'n1';
const ITEM = 'i1';
const ngo: AuthUser = { id: NGO, role: 'NGO', city: 'São Paulo', state: 'SP', ngoStatus: 'ATIVO' };
const donor: AuthUser = { id: DONOR, role: 'DONOR', city: 'São Paulo', state: 'SP', ngoStatus: null };

const item = (over: Partial<Item> = {}): Item => ({
  id: ITEM,
  donor_id: DONOR,
  title: 'Casaco',
  notes: null,
  description: null,
  category: 'ROUPAS',
  city: 'São Paulo',
  state: 'SP',
  status: 'DISPONIVEL',
  selected_ngo_id: null,
  created_at: new Date(),
  completed_at: null,
  moderation_status: 'VISIVEL',
  moderation_reason: null,
  ...over,
});

function setup(over: {
  itemsRepo?: Partial<InterestsDeps['itemsRepo']>;
  interestsRepo?: Partial<InterestsDeps['interestsRepo']>;
} = {}) {
  const eventsRepo = { insert: vi.fn(async () => {}) };
  const service = createInterestsService({
    db: fakeDb(),
    itemsRepo: { findById: async (): Promise<Item | null> => item(), selectNgoIfAvailable: async () => null, ...over.itemsRepo },
    interestsRepo: {
      insertIfAvailable: async () => null,
      exists: async () => false,
      deleteUnlessSelected: async () => false,
      listByItem: async () => [],
      ...over.interestsRepo,
    } as InterestsDeps['interestsRepo'],
    eventsRepo,
  });
  return { service, eventsRepo };
}

describe('interestsService.like', () => {
  it('devolve a curtida criada', async () => {
    const created = { id: 'x', item_id: ITEM, ngo_id: NGO, created_at: new Date() };
    const { service } = setup({ interestsRepo: { insertIfAvailable: async () => created } });
    await expect(service.like(ngo, ITEM)).resolves.toBe(created);
  });

  it.each([
    ['ITEM_NOT_FOUND', 404, { itemsRepo: { findById: async (): Promise<Item | null> => null } }],
    ['OUT_OF_REGION', 403, { itemsRepo: { findById: async (): Promise<Item | null> => item({ city: 'Campinas' }) } }],
    ['ALREADY_INTERESTED', 409, { interestsRepo: { exists: async () => true } }],
    ['ITEM_NOT_AVAILABLE', 409, { itemsRepo: { findById: async (): Promise<Item | null> => item({ status: 'EM_PROGRESSO' }) } }],
  ] as const)('%s', async (code, status, over) => {
    const { service } = setup(over as Parameters<typeof setup>[0]);
    await expect(service.like(ngo, ITEM)).rejects.toMatchObject({ code, status });
  });
});

describe('interestsService.unlike', () => {
  it('resolve quando apagou', async () => {
    const { service } = setup({ interestsRepo: { deleteUnlessSelected: async () => true } });
    await expect(service.unlike(ngo, ITEM)).resolves.toBeUndefined();
  });

  it('ALREADY_SELECTED quando a curtida existe mas a ONG é a escolhida', async () => {
    const { service } = setup({ interestsRepo: { exists: async () => true } });
    await expect(service.unlike(ngo, ITEM)).rejects.toMatchObject({ status: 409, code: 'ALREADY_SELECTED' });
  });

  it('INTEREST_NOT_FOUND quando não há curtida', async () => {
    const { service } = setup();
    await expect(service.unlike(ngo, ITEM)).rejects.toMatchObject({ status: 404, code: 'INTEREST_NOT_FOUND' });
  });
});

describe('interestsService.listInterested', () => {
  it('ITEM_NOT_FOUND e FORBIDDEN para quem não é o dono', async () => {
    await expect(setup({ itemsRepo: { findById: async (): Promise<Item | null> => null } }).service.listInterested(donor, ITEM)).rejects.toMatchObject({
      code: 'ITEM_NOT_FOUND',
    });
    await expect(setup().service.listInterested({ ...donor, id: 'outro' }, ITEM)).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
  });
});

describe('interestsService.selectNgo', () => {
  it('caminho feliz: grava o evento DISPONIVEL → EM_PROGRESSO com a ONG', async () => {
    const selected = item({ status: 'EM_PROGRESSO', selected_ngo_id: NGO });
    const { service, eventsRepo } = setup({ itemsRepo: { selectNgoIfAvailable: async () => selected } });
    await expect(service.selectNgo(DONOR, ITEM, NGO)).resolves.toBe(selected);
    expect(eventsRepo.insert).toHaveBeenCalledWith(expect.anything(), {
      itemId: ITEM,
      from: 'DISPONIVEL',
      to: 'EM_PROGRESSO',
      actorId: DONOR,
      ngoId: NGO,
    });
  });

  it.each([
    ['ITEM_NOT_FOUND', 404, { itemsRepo: { findById: async (): Promise<Item | null> => null } }],
    ['FORBIDDEN', 403, { itemsRepo: { findById: async (): Promise<Item | null> => item({ donor_id: 'outro' }) } }],
    ['ITEM_NOT_AVAILABLE', 409, { itemsRepo: { findById: async (): Promise<Item | null> => item({ status: 'DOADO' }) } }],
    ['NGO_NOT_INTERESTED', 409, {}],
    ['NGO_NOT_ACTIVE', 409, { interestsRepo: { exists: async () => true } }],
  ] as const)('%s quando o UPDATE não afeta linhas', async (code, status, over) => {
    const { service, eventsRepo } = setup(over as Parameters<typeof setup>[0]);
    await expect(service.selectNgo(DONOR, ITEM, NGO)).rejects.toMatchObject({ code, status });
    expect(eventsRepo.insert).not.toHaveBeenCalled();
  });
});
