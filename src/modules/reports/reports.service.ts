import type { Db } from '../../core/db';
import { AppError } from '../../core/errors';
import type {
  AuthUser,
  ChatMessage,
  Item,
  ItemEvent,
  Page,
  Report,
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
  itemsRepo: Pick<ItemsRepository, 'findById'>;
  reportsRepo: ReportsRepository;
  eventsRepo: Pick<ItemEventsRepository, 'listByItem'>;
  /** Avisa os administradores de cada denúncia nova. */
  notifier?: Notifier;
}

export interface ReportDetail {
  report: Report;
  item: Item;
  reporter: ReportParty;
  reported: ReportParty;
  events: ItemEvent[];
  messages: ChatMessage[];
}

export const createReportsService = ({ db, itemsRepo, reportsRepo, eventsRepo, notifier = noopNotifier }: ReportsDeps) => ({
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
    const report = await reportsRepo.insert(db.sql, { itemId, reporterId: user.id, reportedId, reason });
    notifier.notify({ type: 'report.created', reportId: report.id, itemId, reporterId: user.id, reportedId });
    return report;
  },

  list(f: { status: ReportStatus; limit: number; offset: number }): Promise<Page<ReportSummary>> {
    return reportsRepo.list(db.sql, f);
  },

  /** Denúncia com o histórico completo do item: eventos e todas as mensagens, de todas as negociações. */
  async detail(id: string): Promise<ReportDetail> {
    const report = await reportsRepo.findById(db.sql, id);
    if (!report) throw new AppError('REPORT_NOT_FOUND');
    const [item, parties, events, messages] = await Promise.all([
      itemsRepo.findById(db.sql, report.item_id),
      reportsRepo.findParties(db.sql, [report.reporter_id, report.reported_id]),
      eventsRepo.listByItem(db.sql, report.item_id),
      reportsRepo.listAllMessages(db.sql, report.item_id),
    ]);
    const party = (userId: string) => parties.find((p) => p.id === userId)!;
    return { report, item: item!, reporter: party(report.reporter_id), reported: party(report.reported_id), events, messages };
  },

  /** Idempotente: resolver de novo devolve a denúncia como está. */
  async resolve(admin: AuthUser, id: string): Promise<Report> {
    const resolved = await reportsRepo.resolveIfOpen(db.sql, id, admin.id);
    if (resolved) return resolved;
    const current = await reportsRepo.findById(db.sql, id);
    if (!current) throw new AppError('REPORT_NOT_FOUND');
    return current;
  },
});

export type ReportsService = ReturnType<typeof createReportsService>;
