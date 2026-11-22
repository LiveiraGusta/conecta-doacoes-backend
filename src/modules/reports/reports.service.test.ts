import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../test/helpers/fake-db';
import type { AuthUser, Item, Report } from '../../types';
import type { ReportsRepository } from './reports.repository';
import { createReportsService } from './reports.service';

const DONOR: AuthUser = { id: 'd1', role: 'DONOR', city: 'São Paulo', state: 'SP', ngoStatus: null };
const NGO: AuthUser = { id: 'n1', role: 'NGO', city: 'São Paulo', state: 'SP', ngoStatus: 'ATIVO' };
const OTHER: AuthUser = { ...NGO, id: 'n2' };
const ADMIN: AuthUser = { id: 'a1', role: 'ADMIN', city: 'São Paulo', state: 'SP', ngoStatus: null };

const item = (over: Partial<Item> = {}) =>
  ({ id: 'i1', donor_id: 'd1', selected_ngo_id: 'n1', status: 'EM_PROGRESSO', ...over }) as Item;
const REPORT = { id: 'r1', item_id: 'i1', status: 'ABERTA' } as Report;

function setup(opts: { item?: Item | null; repo?: Partial<ReportsRepository> } = {}) {
  const reportsRepo = {
    insert: vi.fn(async () => REPORT),
    findById: vi.fn(async () => REPORT as Report | null),
    resolveIfOpen: vi.fn(async () => null as Report | null),
    ...opts.repo,
  } as unknown as ReportsRepository & Record<string, ReturnType<typeof vi.fn>>;
  const notifier = { notify: vi.fn(), drain: async () => {} };
  const service = createReportsService({
    db: fakeDb(),
    itemsRepo: { findById: async () => (opts.item === undefined ? item() : opts.item) },
    reportsRepo,
    eventsRepo: { listByItem: async () => [] },
    notifier,
  });
  return { service, reportsRepo, notifier };
}

describe('reportsService.create', () => {
  it('denunciada é sempre a outra parte', async () => {
    const a = setup();
    await a.service.create(NGO, 'i1', 'motivo qualquer');
    expect(a.reportsRepo.insert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reporterId: 'n1', reportedId: 'd1' }));
    const b = setup();
    await b.service.create(DONOR, 'i1', 'motivo qualquer');
    expect(b.reportsRepo.insert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reporterId: 'd1', reportedId: 'n1' }));
  });

  it('agenda o aviso aos administradores', async () => {
    const { service, notifier } = setup();
    await service.create(DONOR, 'i1', 'motivo qualquer');
    expect(notifier.notify).toHaveBeenCalledWith({
      type: 'report.created',
      reportId: REPORT.id,
      itemId: 'i1',
      reporterId: 'd1',
      reportedId: 'n1',
    });
  });

  it.each([
    ['item inexistente', null, DONOR, 'ITEM_NOT_FOUND'],
    ['doador com item disponível', item({ status: 'DISPONIVEL', selected_ngo_id: null }), DONOR, 'CHAT_CLOSED'],
    ['ONG com item disponível', item({ status: 'DISPONIVEL', selected_ngo_id: null }), NGO, 'FORBIDDEN'],
    ['ONG que não foi escolhida', item(), OTHER, 'FORBIDDEN'],
  ])('%s → %s, sem gravar', async (_caso, it_, user, code) => {
    const { service, reportsRepo, notifier } = setup({ item: it_ as Item | null });
    await expect(service.create(user, 'i1', 'motivo qualquer')).rejects.toMatchObject({ code });
    expect(reportsRepo.insert).not.toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalled();
  });
});

describe('reportsService.resolve', () => {
  it('já resolvida: devolve como está; inexistente: REPORT_NOT_FOUND', async () => {
    expect(await setup().service.resolve(ADMIN, 'r1')).toBe(REPORT);
    await expect(setup({ repo: { findById: async () => null } }).service.resolve(ADMIN, 'x')).rejects.toMatchObject({
      status: 404,
      code: 'REPORT_NOT_FOUND',
    });
  });
});

describe('reportsService.detail', () => {
  it('REPORT_NOT_FOUND', async () => {
    await expect(setup({ repo: { findById: async () => null } }).service.detail('x')).rejects.toMatchObject({
      code: 'REPORT_NOT_FOUND',
    });
  });
});
