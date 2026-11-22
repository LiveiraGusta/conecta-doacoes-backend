import type { Db } from '../../core/db';
import { AppError } from '../../core/errors';
import type { RealtimeBus } from '../../core/realtime';
import type {
  AuthUser,
  ChatMessage,
  Item,
  ItemEvent,
  ItemReportRow,
  Page,
  Report,
  ReportCategory,
  ReportKind,
  ReportParty,
  ReportStatus,
  ReportSummary,
} from '../../types';
import type { ItemEventsRepository } from '../items/item-events.repository';
import type { ItemsRepository } from '../items/items.repository';
import { noopNotifier, type Notifier } from '../notifications/notifications.service';
import type { ReportsRepository } from './reports.repository';

export interface ReportsDeps {
  db: Pick<Db, 'sql' | 'tx'>;
  itemsRepo: Pick<ItemsRepository, 'findById' | 'findView' | 'lockById' | 'hideIfVisible' | 'setModeration'>;
  reportsRepo: ReportsRepository;
  eventsRepo: Pick<ItemEventsRepository, 'listByItem' | 'insert'>;
  bus: Pick<RealtimeBus, 'publish'>;
  /** Avisa os administradores de cada denúncia nova. */
  notifier?: Notifier;
}

export interface ReportDetail {
  report: Report;
  item: Item & { photos: string[] };
  reporter: ReportParty;
  reported: ReportParty;
  itemReports: ItemReportRow[];
  events: ItemEvent[];
  messages: ChatMessage[];
}

export interface ModerationResult {
  item: Item;
  cancelledNegotiation: boolean;
  resolvedReports: number;
}

/** Pessoas diferentes com denúncia de anúncio aberta para o item sair do ar sozinho. */
export const AUTO_HIDE_THRESHOLD = 3;

/** findView pede quem está vendo; o Admin não curte nada. */
const NO_VIEWER = '00000000-0000-0000-0000-000000000000';

export const createReportsService = ({ db, itemsRepo, reportsRepo, eventsRepo, bus, notifier = noopNotifier }: ReportsDeps) => ({
  /**
   * Denuncia a outra parte da negociação atual. Mesmas regras de acesso do chat:
   * 404 se o item não existe; item DISPONIVEL → CHAT_CLOSED para o doador e 403 para os demais;
   * quem não é o doador nem a ONG escolhida → 403.
   */
  async create(user: AuthUser, itemId: string, reason: string): Promise<Report> {
    const item = await itemsRepo.findById(db.sql, itemId);
    if (!item) throw new AppError('ITEM_NOT_FOUND');
    if (item.status === 'DISPONIVEL') {
      if (user.id === item.donor_id) throw new AppError('CHAT_CLOSED');
      throw new AppError('FORBIDDEN');
    }
    if (user.id !== item.donor_id && user.id !== item.selected_ngo_id) {
      throw new AppError('FORBIDDEN', 'Você não participa desta negociação.');
    }
    const reportedId = user.id === item.donor_id ? item.selected_ngo_id! : item.donor_id;
    const report = await reportsRepo.insert(db.sql, { itemId, reporterId: user.id, reportedId, kind: 'CHAT', reason });
    notifier.notify({ type: 'report.created', reportId: report.id, itemId, reporterId: user.id, reportedId });
    return report;
  },

  /**
   * Denuncia o conteúdo de um anúncio (qualquer doador ou ONG logado, menos o dono).
   * Anúncio fora do ar se comporta como no detalhe: 404 para quem não é da negociação.
   * Ao chegar a AUTO_HIDE_THRESHOLD pessoas com denúncia aberta, o anúncio fica OCULTO até o Admin decidir.
   * A linha do item fica travada durante a transação: denúncias simultâneas contam certo.
   */
  async createForItem(
    user: AuthUser,
    itemId: string,
    input: { category: ReportCategory; reason?: string },
  ): Promise<Report> {
    return db.tx(async (tx) => {
      const item = await itemsRepo.lockById(tx, itemId);
      if (!item || item.moderation_status === 'REMOVIDO') throw new AppError('ITEM_NOT_FOUND');
      if (user.id === item.donor_id) throw new AppError('FORBIDDEN', 'Você não pode denunciar o próprio anúncio.');
      if (item.moderation_status === 'OCULTO' && user.id !== item.selected_ngo_id) throw new AppError('ITEM_NOT_FOUND');

      const report = await reportsRepo.insert(tx, {
        itemId,
        reporterId: user.id,
        reportedId: item.donor_id,
        kind: 'ITEM',
        category: input.category,
        reason: input.reason ?? null,
      });
      if ((await reportsRepo.countOpenItemReporters(tx, itemId)) >= AUTO_HIDE_THRESHOLD) {
        await itemsRepo.hideIfVisible(tx, itemId);
      }
      return report;
    });
  },

  list(f: { status: ReportStatus; kind?: ReportKind; limit: number; offset: number }): Promise<Page<ReportSummary>> {
    return reportsRepo.list(db.sql, f);
  },

  /**
   * Denúncia com o contexto do item: eventos, fotos e todas as denúncias de anúncio dele.
   * A conversa completa só vem nas denúncias de negociação.
   */
  async detail(id: string): Promise<ReportDetail> {
    const report = await reportsRepo.findById(db.sql, id);
    if (!report) throw new AppError('REPORT_NOT_FOUND');
    const [item, parties, itemReports, events, messages] = await Promise.all([
      itemsRepo.findView(db.sql, report.item_id, NO_VIEWER),
      reportsRepo.findParties(db.sql, [report.reporter_id, report.reported_id]),
      reportsRepo.listItemReports(db.sql, report.item_id),
      eventsRepo.listByItem(db.sql, report.item_id),
      report.kind === 'CHAT' ? reportsRepo.listAllMessages(db.sql, report.item_id) : Promise.resolve([]),
    ]);
    const party = (userId: string) => parties.find((p) => p.id === userId)!;
    return {
      report,
      item: item!,
      reporter: party(report.reporter_id),
      reported: party(report.reported_id),
      itemReports,
      events,
      messages,
    };
  },

  /**
   * Idempotente: resolver de novo devolve a denúncia como está.
   * Denúncia de anúncio aberta não se resolve sozinha: o Admin remove ou mantém o anúncio.
   */
  async resolve(admin: AuthUser, id: string): Promise<Report> {
    const current = await reportsRepo.findById(db.sql, id);
    if (!current) throw new AppError('REPORT_NOT_FOUND');
    if (current.kind === 'ITEM' && current.status === 'ABERTA') {
      throw new AppError('CONFLICT', 'Denúncia de anúncio: remova ou mantenha o anúncio.');
    }
    return (await reportsRepo.resolveIfOpen(db.sql, id, admin.id)) ?? current;
  },

  /**
   * Tira o anúncio do ar de vez (REMOVIDO) com um motivo que o doador vê. Uma negociação em andamento
   * é cancelada (mesmos eventos do cancelamento comum, com o Admin como autor) e as partes são avisadas
   * pelo tempo real. Resolve as denúncias de anúncio abertas como ITEM_REMOVIDO.
   * Idempotente: remover de novo não muda o motivo nem cancela nada.
   */
  async removeItem(admin: AuthUser, itemId: string, reason: string): Promise<ModerationResult> {
    const result = await db.tx(async (tx) => {
      const before = await itemsRepo.lockById(tx, itemId);
      if (!before) throw new AppError('ITEM_NOT_FOUND');

      let item = before;
      let cancelledNegotiation = false;
      if (before.moderation_status !== 'REMOVIDO') {
        item = (await itemsRepo.setModeration(tx, itemId, { status: 'REMOVIDO', reason, adminId: admin.id }))!;
        cancelledNegotiation = before.status === 'EM_PROGRESSO';
        if (cancelledNegotiation) {
          const base = {
            itemId,
            actorId: admin.id,
            ngoId: before.selected_ngo_id,
            reason: `Anúncio removido pela moderação: ${reason}`,
          };
          await eventsRepo.insert(tx, [
            { ...base, from: 'EM_PROGRESSO', to: 'CANCELADO' },
            { ...base, from: 'CANCELADO', to: 'DISPONIVEL' },
          ]);
        }
      }
      const resolvedReports = await reportsRepo.resolveOpenItemReports(tx, itemId, admin.id, 'ITEM_REMOVIDO');
      return { item, cancelledNegotiation, resolvedReports };
    });

    if (result.cancelledNegotiation) {
      bus.publish({
        type: 'item.status_changed',
        itemId,
        from: 'EM_PROGRESSO',
        to: 'DISPONIVEL',
        actorId: admin.id,
        actorRole: 'ADMIN',
        reason: 'Anúncio removido pela moderação.',
        completedAt: null,
      });
    }
    return result;
  },

  /**
   * Mantém o anúncio no ar (VISIVEL), descartando as denúncias abertas como IMPROCEDENTE.
   * Também republica um anúncio removido por engano.
   */
  async restoreItem(admin: AuthUser, itemId: string): Promise<ModerationResult> {
    return db.tx(async (tx) => {
      const before = await itemsRepo.lockById(tx, itemId);
      if (!before) throw new AppError('ITEM_NOT_FOUND');
      const item = (await itemsRepo.setModeration(tx, itemId, { status: 'VISIVEL', reason: null, adminId: admin.id }))!;
      const resolvedReports = await reportsRepo.resolveOpenItemReports(tx, itemId, admin.id, 'IMPROCEDENTE');
      return { item, cancelledNegotiation: false, resolvedReports };
    });
  },
});

export type ReportsService = ReturnType<typeof createReportsService>;
