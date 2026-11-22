/**
 * Notificações por e-mail dos pontos importantes do fluxo.
 *
 * Os services só chamam `notify(evento)` e seguem: a busca dos destinatários e o envio acontecem
 * em segundo plano. Falha no envio nunca muda a resposta da API, só vai para o log (`onError`).
 * Mensagens novas do chat NÃO geram e-mail: o app já avisa em tempo real e o volume seria alto.
 */
import type { Db } from '../../core/db';
import type { EmailMessage, Mailer } from '../../core/email';
import type { ReportCategory } from '../../types';
import type { Contact, NotificationsRepository } from './notifications.repository';
import { links, templates, type EmailContent } from './notifications.templates';

export type NotificationEvent =
  /** Doador criou a conta. */
  | { type: 'donor.registered'; userId: string }
  /** ONG criou a conta: a ONG recebe a confirmação e os administradores, o aviso de análise. */
  | { type: 'ngo.registered'; userId: string }
  /** ONG pendente ou rejeitada mandou documento novo: avisa os administradores. */
  | { type: 'ngo.document_resubmitted'; userId: string }
  | { type: 'ngo.approved'; userId: string }
  | { type: 'ngo.rejected'; userId: string; reason: string | null }
  /** ONG demonstrou interesse: avisa o doador. */
  | { type: 'interest.created'; itemId: string; ngoId: string }
  /** Doador escolheu a ONG: avisa a ONG. */
  | { type: 'ngo.selected'; itemId: string; ngoId: string }
  /** Uma parte cancelou: avisa a outra. */
  | { type: 'negotiation.cancelled'; itemId: string; actorId: string; counterpartId: string; reason: string | null }
  /** ONG confirmou o recebimento: avisa o doador. */
  | { type: 'donation.completed'; itemId: string; ngoId: string }
  /** Troca de senha (no perfil ou pelo link de redefinição): aviso de segurança. */
  | { type: 'password.changed'; userId: string }
  /** Denúncia aberta: avisa os administradores. */
  | { type: 'report.created'; reportId: string; itemId: string; reporterId: string; reportedId: string }
  /** Denúncia de anúncio: avisa os administradores; `hidden` = esta denúncia tirou o anúncio do ar. */
  | { type: 'item.reported'; reportId: string; itemId: string; reporterId: string; category: ReportCategory; hidden: boolean }
  /**
   * Administrador removeu o anúncio: avisa o doador (com o motivo) e, se havia negociação,
   * a ONG escolhida. O doador não fica sabendo quem denunciou.
   */
  | { type: 'item.removed'; itemId: string; reason: string; cancelledNgoId: string | null }
  /** Conta excluída. Os dados vêm prontos porque, depois da exclusão, o e-mail real não existe mais no banco. */
  | { type: 'account.deleted'; email: string; name: string };

export type NotificationType = NotificationEvent['type'];

export interface Notifier {
  /** Agenda o envio e volta na hora; nunca lança. */
  notify(event: NotificationEvent): void;
  /** Espera os envios em andamento (testes e desligamento da API). */
  drain(): Promise<void>;
}

/** Mesmos rótulos da tela "Denunciar anúncio" do app. */
const CATEGORY_LABELS: Record<ReportCategory, string> = {
  NUDEZ: 'Nudez ou conteúdo sexual',
  ODIO: 'Discurso de ódio ou discriminação',
  VIOLENCIA: 'Violência ou conteúdo chocante',
  GOLPE: 'Golpe ou fraude',
  PROIBIDO: 'Item proibido',
  SPAM: 'Não é doação ou é propaganda',
  OUTRO: 'Outro motivo',
};

/** Para services criados sem notificações (testes unitários antigos, scripts). */
export const noopNotifier: Notifier = { notify: () => {}, drain: async () => {} };

export interface NotifierDeps {
  db: Pick<Db, 'sql'>;
  repo: NotificationsRepository;
  mailer: Mailer;
  /** URL do frontend (APP_URL): base dos links dos e-mails. */
  appUrl: string;
  onError(err: unknown, event: NotificationEvent): void;
}

export function createNotifier({ db, repo, mailer, appUrl, onError }: NotifierDeps): Notifier {
  const l = links(appUrl);
  const pending = new Set<Promise<void>>();

  const to = (contact: Pick<Contact, 'email'>, content: EmailContent): EmailMessage => ({ to: contact.email, ...content });

  /** Busca as pessoas pelo id; quem não existe (ou foi excluído) fica de fora. */
  async function contacts(...ids: string[]) {
    const found = await repo.findContacts(db.sql, ids);
    return (id: string) => found.find((c) => c.id === id);
  }

  /** Monta os e-mails do evento. Lista vazia = ninguém a avisar. */
  async function build(event: NotificationEvent): Promise<EmailMessage[]> {
    switch (event.type) {
      case 'donor.registered': {
        const user = (await contacts(event.userId))(event.userId);
        return user ? [to(user, templates.donorWelcome(user, l))] : [];
      }
      case 'ngo.registered':
      case 'ngo.document_resubmitted': {
        const ngo = (await contacts(event.userId))(event.userId);
        if (!ngo) return [];
        const resubmitted = event.type === 'ngo.document_resubmitted';
        const admins = await repo.findAdmins(db.sql);
        return [
          ...(resubmitted ? [] : [to(ngo, templates.ngoRegistered(ngo, l))]),
          ...admins.map((a) => to(a, templates.adminNgoToReview({ adminName: a.name, ngoName: ngo.name, resubmitted }, l))),
        ];
      }
      case 'ngo.approved': {
        const ngo = (await contacts(event.userId))(event.userId);
        return ngo ? [to(ngo, templates.ngoApproved(ngo, l))] : [];
      }
      case 'ngo.rejected': {
        const ngo = (await contacts(event.userId))(event.userId);
        return ngo ? [to(ngo, templates.ngoRejected({ name: ngo.name, reason: event.reason }, l))] : [];
      }
      case 'interest.created': {
        const item = await repo.findItem(db.sql, event.itemId);
        if (!item) return [];
        const find = await contacts(item.donor_id, event.ngoId);
        const donor = find(item.donor_id);
        const ngo = find(event.ngoId);
        if (!donor || !ngo) return [];
        return [
          to(donor, templates.interestReceived({ donorName: donor.name, ngoName: ngo.name, itemId: item.id, itemTitle: item.title }, l)),
        ];
      }
      case 'ngo.selected': {
        const item = await repo.findItem(db.sql, event.itemId);
        if (!item) return [];
        const find = await contacts(item.donor_id, event.ngoId);
        const donor = find(item.donor_id);
        const ngo = find(event.ngoId);
        if (!donor || !ngo) return [];
        return [to(ngo, templates.ngoSelected({ ngoName: ngo.name, donorName: donor.name, itemId: item.id, itemTitle: item.title }, l))];
      }
      case 'negotiation.cancelled': {
        const item = await repo.findItem(db.sql, event.itemId);
        if (!item) return [];
        const find = await contacts(event.actorId, event.counterpartId);
        const actor = find(event.actorId);
        const other = find(event.counterpartId);
        if (!actor || !other) return [];
        return [
          to(
            other,
            templates.negotiationCancelled(
              { name: other.name, byName: actor.name, byNgo: actor.role === 'NGO', itemTitle: item.title, reason: event.reason },
              l,
            ),
          ),
        ];
      }
      case 'donation.completed': {
        const item = await repo.findItem(db.sql, event.itemId);
        if (!item) return [];
        const find = await contacts(item.donor_id, event.ngoId);
        const donor = find(item.donor_id);
        const ngo = find(event.ngoId);
        if (!donor || !ngo) return [];
        return [to(donor, templates.donationCompleted({ donorName: donor.name, ngoName: ngo.name, itemTitle: item.title }, l))];
      }
      case 'password.changed': {
        const user = (await contacts(event.userId))(event.userId);
        return user ? [to(user, templates.passwordChanged(user, l))] : [];
      }
      case 'report.created': {
        const [item, find, admins] = await Promise.all([
          repo.findItem(db.sql, event.itemId),
          contacts(event.reporterId, event.reportedId),
          repo.findAdmins(db.sql),
        ]);
        if (!item) return [];
        const reporterName = find(event.reporterId)?.name ?? 'Usuário removido';
        const reportedName = find(event.reportedId)?.name ?? 'Usuário removido';
        return admins.map((a) =>
          to(a, templates.reportCreated({ adminName: a.name, reporterName, reportedName, itemTitle: item.title, reportId: event.reportId }, l)),
        );
      }
      case 'item.reported': {
        const [item, find, admins] = await Promise.all([
          repo.findItem(db.sql, event.itemId),
          contacts(event.reporterId),
          repo.findAdmins(db.sql),
        ]);
        if (!item) return [];
        const reporterName = find(event.reporterId)?.name ?? 'Usuário removido';
        return admins.map((a) =>
          to(
            a,
            templates.itemReported(
              {
                adminName: a.name,
                reporterName,
                itemTitle: item.title,
                category: CATEGORY_LABELS[event.category],
                reportId: event.reportId,
                hidden: event.hidden,
              },
              l,
            ),
          ),
        );
      }
      case 'item.removed': {
        const item = await repo.findItem(db.sql, event.itemId);
        if (!item) return [];
        const find = await contacts(item.donor_id, ...(event.cancelledNgoId ? [event.cancelledNgoId] : []));
        const donor = find(item.donor_id);
        const ngo = event.cancelledNgoId ? find(event.cancelledNgoId) : undefined;
        const cancelledNegotiation = event.cancelledNgoId !== null;
        return [
          ...(donor
            ? [to(donor, templates.itemRemoved({ name: donor.name, itemTitle: item.title, reason: event.reason, cancelledNegotiation }, l))]
            : []),
          ...(ngo ? [to(ngo, templates.negotiationEndedByModeration({ ngoName: ngo.name, itemTitle: item.title }, l))] : []),
        ];
      }
      case 'account.deleted':
        return [to({ email: event.email }, templates.accountDeleted({ name: event.name }))];
    }
  }

  async function deliver(event: NotificationEvent) {
    const messages = await build(event);
    // Cada destinatário independe dos outros: um envio que falha não derruba os demais.
    await Promise.all(messages.map((m) => mailer.send(m).catch((err: unknown) => onError(err, event))));
  }

  return {
    notify(event) {
      const job: Promise<void> = deliver(event)
        .catch((err: unknown) => onError(err, event))
        .finally(() => pending.delete(job));
      pending.add(job);
    },
    async drain() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
