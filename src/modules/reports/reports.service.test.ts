import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../test/helpers/fake-db';
import type { AuthUser, Item, Report } from '../../types';
import type { ReportsRepository } from './reports.repository';
import { AUTO_HIDE_THRESHOLD, createReportsService } from './reports.service';

const DONOR: AuthUser = { id: 'd1', role: 'DONOR', city: 'São Paulo', state: 'SP', ngoStatus: null };
const NGO: AuthUser = { id: 'n1', role: 'NGO', city: 'São Paulo', state: 'SP', ngoStatus: 'ATIVO' };
const OTHER: AuthUser = { ...NGO, id: 'n2' };
const ADMIN: AuthUser = { id: 'a1', role: 'ADMIN', city: 'São Paulo', state: 'SP', ngoStatus: null };

const item = (over: Partial<Item> = {}) =>
  ({
    id: 'i1',
    donor_id: 'd1',
    selected_ngo_id: 'n1',
    status: 'EM_PROGRESSO',
    moderation_status: 'VISIVEL',
    moderation_reason: null,
    ...over,
  }) as Item;
const REPORT = { id: 'r1', item_id: 'i1', kind: 'CHAT', status: 'ABERTA' } as Report;

function setup(opts: { item?: Item | null; repo?: Partial<ReportsRepository>; openReporters?: number } = {}) {
  const current = () => (opts.item === undefined ? item() : opts.item);
  const reportsRepo = {
    insert: vi.fn(async () => REPORT),
    findById: vi.fn(async () => REPORT as Report | null),
    resolveIfOpen: vi.fn(async () => null as Report | null),
    countOpenItemReporters: vi.fn(async () => opts.openReporters ?? 1),
    resolveOpenItemReports: vi.fn(async () => 2),
    ...opts.repo,
  } as unknown as ReportsRepository & Record<string, ReturnType<typeof vi.fn>>;
  const itemsRepo = {
    findById: async () => current(),
    findView: async () => null,
    lockById: async () => current(),
    hideIfVisible: vi.fn(async () => current()),
    setModeration: vi.fn(async (_q: unknown, _id: string, m: { status: Item['moderation_status']; reason: string | null }) => ({
      ...current()!,
      status: m.status === 'REMOVIDO' && current()!.status === 'EM_PROGRESSO' ? 'DISPONIVEL' : current()!.status,
      moderation_status: m.status,
      moderation_reason: m.reason,
    })),
  };
  const eventsRepo = { listByItem: async () => [], insert: vi.fn(async () => {}) };
  const bus = { publish: vi.fn() };
  const notifier = { notify: vi.fn(), drain: async () => {} };
  const service = createReportsService({ db: fakeDb(), itemsRepo, reportsRepo, eventsRepo, bus, notifier });
  return { service, reportsRepo, itemsRepo, eventsRepo, bus, notifier };
}

describe('reportsService.create (negociação)', () => {
  it('denunciada é sempre a outra parte', async () => {
    const a = setup();
    await a.service.create(NGO, 'i1', 'motivo qualquer');
    expect(a.reportsRepo.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reporterId: 'n1', reportedId: 'd1', kind: 'CHAT' }),
    );
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

describe('reportsService.createForItem (anúncio)', () => {
  const input = { category: 'NUDEZ' as const };

  it('qualquer ONG ou doador denuncia; a denunciada é o doador do item', async () => {
    const { service, reportsRepo, itemsRepo } = setup({ item: item({ status: 'DISPONIVEL', selected_ngo_id: null }) });
    await service.createForItem(OTHER, 'i1', input);
    expect(reportsRepo.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reporterId: 'n2', reportedId: 'd1', kind: 'ITEM', category: 'NUDEZ', reason: null }),
    );
    expect(itemsRepo.hideIfVisible).not.toHaveBeenCalled();
  });

  it(`oculta o anúncio ao chegar a ${AUTO_HIDE_THRESHOLD} pessoas com denúncia aberta`, async () => {
    const below = setup({ openReporters: AUTO_HIDE_THRESHOLD - 1 });
    await below.service.createForItem(OTHER, 'i1', input);
    expect(below.itemsRepo.hideIfVisible).not.toHaveBeenCalled();

    const at = setup({ openReporters: AUTO_HIDE_THRESHOLD });
    await at.service.createForItem(OTHER, 'i1', input);
    expect(at.itemsRepo.hideIfVisible).toHaveBeenCalledWith(expect.anything(), 'i1');
  });

  it('avisa os administradores; `hidden` só na denúncia que tirou o anúncio do ar', async () => {
    const below = setup({ openReporters: 1 });
    await below.service.createForItem(OTHER, 'i1', input);
    expect(below.notifier.notify).toHaveBeenCalledWith({
      type: 'item.reported',
      reportId: 'r1',
      itemId: 'i1',
      reporterId: 'n2',
      category: 'NUDEZ',
      hidden: false,
    });

    const at = setup({ openReporters: AUTO_HIDE_THRESHOLD });
    await at.service.createForItem(OTHER, 'i1', input);
    expect(at.notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ hidden: true }));

    // Já estava oculto: hideIfVisible não muda nada → não conta como "tirou do ar".
    const after = setup({ openReporters: AUTO_HIDE_THRESHOLD + 1 });
    after.itemsRepo.hideIfVisible.mockResolvedValueOnce(null);
    await after.service.createForItem(OTHER, 'i1', input);
    expect(after.notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ hidden: false }));
  });

  it('denúncia recusada não avisa ninguém', async () => {
    const { service, notifier } = setup({ item: item() });
    await expect(service.createForItem(DONOR, 'i1', input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it.each([
    ['item inexistente', null, OTHER, 'ITEM_NOT_FOUND'],
    ['anúncio removido', item({ moderation_status: 'REMOVIDO' }), OTHER, 'ITEM_NOT_FOUND'],
    ['anúncio oculto, quem está de fora', item({ moderation_status: 'OCULTO' }), OTHER, 'ITEM_NOT_FOUND'],
    ['o próprio doador', item(), DONOR, 'FORBIDDEN'],
  ])('%s → %s, sem gravar', async (_caso, it_, user, code) => {
    const { service, reportsRepo } = setup({ item: it_ as Item | null });
    await expect(service.createForItem(user, 'i1', input)).rejects.toMatchObject({ code });
    expect(reportsRepo.insert).not.toHaveBeenCalled();
  });

  it('anúncio oculto: a ONG da negociação ainda denuncia', async () => {
    const { service, reportsRepo } = setup({ item: item({ moderation_status: 'OCULTO' }) });
    await service.createForItem(NGO, 'i1', input);
    expect(reportsRepo.insert).toHaveBeenCalled();
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

  it('denúncia de anúncio aberta não se resolve sem decidir o anúncio (409)', async () => {
    const open = { ...REPORT, kind: 'ITEM' } as Report;
    const { service, reportsRepo } = setup({ repo: { findById: async () => open } });
    await expect(service.resolve(ADMIN, 'r1')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(reportsRepo.resolveIfOpen).not.toHaveBeenCalled();
  });
});

describe('reportsService.detail', () => {
  it('REPORT_NOT_FOUND', async () => {
    await expect(setup({ repo: { findById: async () => null } }).service.detail('x')).rejects.toMatchObject({
      code: 'REPORT_NOT_FOUND',
    });
  });
});

describe('reportsService.removeItem / restoreItem', () => {
  it('remover item em negociação: cancela (2 eventos), avisa pelo tempo real e resolve as denúncias', async () => {
    const { service, eventsRepo, bus, reportsRepo } = setup();
    const res = await service.removeItem(ADMIN, 'i1', 'Foto com nudez explícita');
    expect(res).toMatchObject({ cancelledNegotiation: true, resolvedReports: 2 });
    expect(res.item).toMatchObject({ status: 'DISPONIVEL', moderation_status: 'REMOVIDO' });
    expect(eventsRepo.insert).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({ from: 'EM_PROGRESSO', to: 'CANCELADO', actorId: 'a1', ngoId: 'n1' }),
      expect.objectContaining({ from: 'CANCELADO', to: 'DISPONIVEL' }),
    ]);
    expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'item.status_changed', actorRole: 'ADMIN' }));
    expect(reportsRepo.resolveOpenItemReports).toHaveBeenCalledWith(expect.anything(), 'i1', 'a1', 'ITEM_REMOVIDO');
  });

  it('remover item em negociação: e-mail para o doador e para a ONG escolhida', async () => {
    const { service, notifier } = setup();
    await service.removeItem(ADMIN, 'i1', 'Foto com nudez explícita');
    expect(notifier.notify).toHaveBeenCalledWith({
      type: 'item.removed',
      itemId: 'i1',
      reason: 'Foto com nudez explícita',
      cancelledNgoId: 'n1',
    });
  });

  it('remover item disponível ou doado: sem eventos nem tempo real; e-mail só para o doador', async () => {
    const { service, eventsRepo, bus, notifier } = setup({ item: item({ status: 'DOADO' }) });
    expect((await service.removeItem(ADMIN, 'i1', 'Discurso de ódio')).cancelledNegotiation).toBe(false);
    expect(eventsRepo.insert).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'item.removed', cancelledNgoId: null }));
  });

  it('remover de novo é idempotente: não muda o motivo nem manda e-mail', async () => {
    const { service, itemsRepo, notifier } = setup({ item: item({ moderation_status: 'REMOVIDO', moderation_reason: 'antes' }) });
    const res = await service.removeItem(ADMIN, 'i1', 'outro motivo qualquer');
    expect(itemsRepo.setModeration).not.toHaveBeenCalled();
    expect(res.item.moderation_reason).toBe('antes');
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('manter: volta a VISIVEL e descarta as denúncias como IMPROCEDENTE', async () => {
    const { service, reportsRepo } = setup({ item: item({ moderation_status: 'OCULTO' }) });
    const res = await service.restoreItem(ADMIN, 'i1');
    expect(res.item.moderation_status).toBe('VISIVEL');
    expect(reportsRepo.resolveOpenItemReports).toHaveBeenCalledWith(expect.anything(), 'i1', 'a1', 'IMPROCEDENTE');
  });

  it('item inexistente → ITEM_NOT_FOUND', async () => {
    await expect(setup({ item: null }).service.removeItem(ADMIN, 'x', 'motivo qualquer')).rejects.toMatchObject({
      code: 'ITEM_NOT_FOUND',
    });
    await expect(setup({ item: null }).service.restoreItem(ADMIN, 'x')).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
  });
});
