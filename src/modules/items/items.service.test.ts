import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../test/helpers/fake-db';
import { fakeStorage } from '../../../test/helpers/fake-storage';
import type { AuthUser, Item, ItemPhoto, ItemView } from '../../types';
import type { ItemEventsRepository } from './item-events.repository';
import type { ItemsRepository } from './items.repository';
import { abbreviateName } from './items.dto';
import { createItemsService } from './items.service';

const DONOR: AuthUser = { id: 'd1', role: 'DONOR', city: 'São Paulo', state: 'SP', ngoStatus: null };
const NGO_ATIVA: AuthUser = { id: 'n1', role: 'NGO', city: 'São Paulo', state: 'SP', ngoStatus: 'ATIVO' };
const NGO_PENDENTE: AuthUser = { ...NGO_ATIVA, id: 'n2', ngoStatus: 'PENDENTE_APROVACAO' };
const INPUT = { title: 'Casaco infantil', category: 'ROUPAS' as const };

let png: Buffer;
beforeAll(async () => {
  png = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#f00' } }).png().toBuffer();
});

const VIEW: ItemView = {
  id: 'i1',
  donor_id: 'd1',
  title: 'Casaco',
  description: null,
  category: 'ROUPAS',
  city: 'São Paulo',
  state: 'SP',
  status: 'EM_PROGRESSO',
  selected_ngo_id: 'n1',
  created_at: new Date(),
  completed_at: null,
  donor_name: 'Marina Souza',
  photos: ['a', 'b', 'c'],
  photo_ids: ['1', '2', '3'],
  interests_count: 2,
  has_user_interest: true,
};

function setup(repo: Partial<ItemsRepository> = {}) {
  const storage = fakeStorage();
  const insertWithPhotos = vi.fn(async (_q: unknown, item: Partial<Item>, urls: string[]) => ({
    ...(item as Item),
    status: 'DISPONIVEL' as const,
    photos: urls.map((photo_url, i) => ({ id: String(i), photo_url }) as ItemPhoto),
  }));
  const eventsRepo = { insert: vi.fn(async () => {}) } as unknown as ItemEventsRepository;
  const itemsRepo = { insertWithPhotos, ...repo } as unknown as ItemsRepository;
  const service = createItemsService({ db: fakeDb(), itemsRepo, eventsRepo, storage });
  return { service, storage, insertWithPhotos, eventsRepo };
}

describe('itemsService.publish', () => {
  it.each([0, 2, 4])('INVALID_PHOTO_COUNT com %i fotos, sem subir nada', async (n) => {
    const { service, storage } = setup();
    await expect(service.publish(DONOR, INPUT, Array(n).fill(png))).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_PHOTO_COUNT',
    });
    expect(storage.files.size).toBe(0);
  });

  it('INVALID_PHOTO quando um arquivo não é imagem', async () => {
    const { service, storage } = setup();
    await expect(service.publish(DONOR, INPUT, [png, png, Buffer.from('%PDF-1.4')])).rejects.toMatchObject({
      code: 'INVALID_PHOTO',
    });
    expect(storage.files.size).toBe(0);
  });

  it('converte para webp com maior lado em 1600 px, sobe em <item_id>/ e grava o evento', async () => {
    const { service, storage, insertWithPhotos, eventsRepo } = setup();
    const item = await service.publish(DONOR, INPUT, [png, png, png]);

    const keys = [...storage.files.keys()];
    expect(keys).toHaveLength(3);
    for (const k of keys) expect(k).toMatch(new RegExp(`^items/${item.id}/[0-9a-f-]{36}\\.webp$`));

    const meta = await sharp(storage.files.get(keys[0]!)!.body).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 1600, height: 800 });

    expect(insertWithPhotos.mock.calls[0]![1]).toMatchObject({ city: 'São Paulo', state: 'SP', description: null });
    expect(eventsRepo.insert).toHaveBeenCalledWith(expect.anything(), {
      itemId: item.id,
      from: null,
      to: 'DISPONIVEL',
      actorId: DONOR.id,
    });
  });

  it('usa cidade/UF informadas no lugar das do doador', async () => {
    const { service, insertWithPhotos } = setup();
    await service.publish(DONOR, { ...INPUT, city: 'Campinas', state: 'SP' }, [png, png, png]);
    expect(insertWithPhotos.mock.calls[0]![1]).toMatchObject({ city: 'Campinas', state: 'SP' });
  });

  it('apaga as 3 fotos do Storage se a transação falhar', async () => {
    const { service, storage } = setup({
      insertWithPhotos: async () => {
        throw new Error('banco caiu');
      },
    });
    await expect(service.publish(DONOR, INPUT, [png, png, png])).rejects.toThrow('banco caiu');
    expect(storage.files.size).toBe(0);
  });

  it('apaga as fotos já enviadas se um dos uploads falhar', async () => {
    const { service, storage } = setup();
    storage.failNextUpload();
    await expect(service.publish(DONOR, INPUT, [png, png, png])).rejects.toThrow('upload falhou');
    expect(storage.files.size).toBe(0);
  });
});

describe('itemsService — contexto de quem vê', () => {
  const page = { total: 1, rows: [VIEW] };

  it('ONG ativa vê has_user_interest e is_selected', async () => {
    const { service } = setup({ findFeed: async () => page });
    const { rows } = await service.feed(NGO_ATIVA, { limit: 30, offset: 0 });
    expect(rows[0]).toMatchObject({ has_user_interest: true, is_selected: true });
  });

  it('ONG pendente recebe has_user_interest = false', async () => {
    const { service } = setup({ findFeed: async () => page });
    const { rows } = await service.feed(NGO_PENDENTE, { limit: 30, offset: 0 });
    expect(rows[0]).toMatchObject({ has_user_interest: false, is_selected: false });
  });

  it('feed usa a cidade/UF do usuário logado', async () => {
    const findFeed = vi.fn(async () => page);
    const { service } = setup({ findFeed });
    await service.feed({ ...DONOR, city: 'Recife', state: 'PE' }, { limit: 30, offset: 0 });
    expect(findFeed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ city: 'Recife', state: 'PE' }));
  });

  it('detail: ITEM_NOT_FOUND', async () => {
    const { service } = setup({ findView: async () => null });
    await expect(service.detail(DONOR, 'x')).rejects.toMatchObject({ status: 404, code: 'ITEM_NOT_FOUND' });
  });
});

describe('abbreviateName', () => {
  it.each([
    ['Marina Souza', 'Marina S.'],
    ['Ana Maria de oliveira', 'Ana O.'],
    ['  Pedro  ', 'Pedro'],
  ])('%s → %s', (full, short) => expect(abbreviateName(full)).toBe(short));
});
