/**
 * Modelos dos e-mails de notificação. Todo texto vindo do usuário (nome, título, motivo) é
 * escapado no HTML; a versão em texto puro vai junto para leitores que não mostram HTML.
 */
import { escapeHtml, type EmailMessage } from '../../core/email';

export type EmailContent = Omit<EmailMessage, 'to'>;

interface Layout {
  subject: string;
  greeting: string;
  /** Parágrafos já com o texto final (sem HTML); cada um vira um <p>. */
  paragraphs: string[];
  /** Citação em destaque (ex.: motivo da rejeição ou do cancelamento). */
  quote?: string;
  cta?: { label: string; url: string };
  footnote?: string;
}

const BRAND = 'Conecta Doações';

function render(l: Layout): EmailContent {
  const text = [
    l.greeting,
    '',
    ...l.paragraphs.flatMap((p) => [p, '']),
    ...(l.quote ? [`"${l.quote}"`, ''] : []),
    ...(l.cta ? [`${l.cta.label}: ${l.cta.url}`, ''] : []),
    ...(l.footnote ? [l.footnote, ''] : []),
    `— Equipe ${BRAND}`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.5">
  <p>${escapeHtml(l.greeting)}</p>
${l.paragraphs.map((p) => `  <p>${escapeHtml(p)}</p>`).join('\n')}${
    l.quote
      ? `\n  <blockquote style="margin:0 0 16px;padding:8px 14px;border-left:4px solid #d1d5db;color:#374151">${escapeHtml(l.quote)}</blockquote>`
      : ''
  }${
    l.cta
      ? `\n  <p><a href="${escapeHtml(l.cta.url)}" style="display:inline-block;padding:10px 18px;background:#16a34a;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(l.cta.label)}</a></p>`
      : ''
  }${l.footnote ? `\n  <p style="font-size:13px;color:#6b7280">${escapeHtml(l.footnote)}</p>` : ''}
  <p style="font-size:13px;color:#6b7280">— Equipe ${BRAND}</p>
</body></html>`;

  return { subject: `${l.subject} — ${BRAND}`, text, html };
}

const hi = (name: string) => `Olá, ${name}!`;

/** Links do frontend; `appUrl` é o APP_URL. */
export const links = (appUrl: string) => {
  const at = (path: string) => new URL(path, appUrl).href;
  return {
    feed: at('/feed'),
    donations: at('/donations'),
    newDonation: at('/donations/new'),
    profile: at('/profile'),
    settings: at('/settings'),
    adminNgos: at('/admin/ngos'),
    interests: (itemId: string) => at(`/donations/${itemId}/interests`),
    chat: (itemId: string) => at(`/chats/${itemId}`),
    report: (reportId: string) => at(`/admin/reports/${reportId}`),
  };
};
export type Links = ReturnType<typeof links>;

export const templates = {
  donorWelcome: (p: { name: string }, l: Links) =>
    render({
      subject: 'Boas-vindas',
      greeting: hi(p.name),
      paragraphs: [
        `Sua conta no ${BRAND} está pronta.`,
        'Publique o que você não usa mais com 3 fotos, veja quais ONGs da sua cidade se interessam e escolha quem vai receber.',
      ],
      cta: { label: 'Publicar uma doação', url: l.newDonation },
    }),

  ngoRegistered: (p: { name: string }, l: Links) =>
    render({
      subject: 'Cadastro recebido',
      greeting: hi(p.name),
      paragraphs: [
        'Recebemos o cadastro da sua ONG e o documento enviado.',
        'A análise costuma levar até 2 dias úteis. Enquanto isso, você já pode ver as doações da sua cidade; o botão "Tenho interesse" aparece assim que a ONG for aprovada.',
      ],
      cta: { label: 'Ver as doações', url: l.feed },
      footnote: 'Avisamos por e-mail quando a análise terminar.',
    }),

  adminNgoToReview: (p: { adminName: string; ngoName: string; resubmitted: boolean }, l: Links) =>
    render({
      subject: p.resubmitted ? `Documento reenviado: ${p.ngoName}` : `Nova ONG para análise: ${p.ngoName}`,
      greeting: hi(p.adminName),
      paragraphs: [
        p.resubmitted
          ? `A ONG ${p.ngoName} enviou um documento novo e voltou para a fila de análise.`
          : `A ONG ${p.ngoName} se cadastrou e está esperando a análise do documento.`,
      ],
      cta: { label: 'Abrir a moderação de ONGs', url: l.adminNgos },
    }),

  ngoApproved: (p: { name: string }, l: Links) =>
    render({
      subject: 'ONG aprovada',
      greeting: hi(p.name),
      paragraphs: [
        'Boa notícia: o cadastro da sua ONG foi aprovado.',
        'Agora vocês já podem demonstrar interesse nas doações da cidade e conversar com os doadores.',
      ],
      cta: { label: 'Ver as doações', url: l.feed },
    }),

  ngoRejected: (p: { name: string; reason: string | null }, l: Links) =>
    render({
      subject: 'Cadastro não aprovado',
      greeting: hi(p.name),
      paragraphs: [
        'Analisamos o cadastro da sua ONG e ele ainda não pôde ser aprovado.',
        ...(p.reason ? ['Motivo informado pela equipe:'] : []),
      ],
      quote: p.reason ?? undefined,
      cta: { label: 'Reenviar o documento', url: l.profile },
      footnote: 'Depois de reenviar, a ONG volta para a fila de análise.',
    }),

  interestReceived: (p: { donorName: string; ngoName: string; itemId: string; itemTitle: string }, l: Links) =>
    render({
      subject: `Nova ONG interessada em "${p.itemTitle}"`,
      greeting: hi(p.donorName),
      paragraphs: [
        `A ONG ${p.ngoName} demonstrou interesse na sua doação "${p.itemTitle}".`,
        'Veja as ONGs interessadas e escolha quem vai receber. Depois da escolha, vocês combinam a entrega pela conversa.',
      ],
      cta: { label: 'Ver ONGs interessadas', url: l.interests(p.itemId) },
    }),

  ngoSelected: (p: { ngoName: string; donorName: string; itemId: string; itemTitle: string }, l: Links) =>
    render({
      subject: `Sua ONG foi escolhida para "${p.itemTitle}"`,
      greeting: hi(p.ngoName),
      paragraphs: [
        `${p.donorName} escolheu a sua ONG para receber a doação "${p.itemTitle}".`,
        'Combinem a entrega pela conversa: dia, horário e local. Depois de receber o item, confirme o recebimento no app.',
      ],
      cta: { label: 'Abrir a conversa', url: l.chat(p.itemId) },
    }),

  negotiationCancelled: (
    p: { name: string; byName: string; byNgo: boolean; itemTitle: string; reason: string | null },
    l: Links,
  ) =>
    render({
      subject: `Negociação cancelada: "${p.itemTitle}"`,
      greeting: hi(p.name),
      paragraphs: [
        `${p.byName} cancelou a negociação da doação "${p.itemTitle}". A conversa foi encerrada.`,
        p.byNgo
          ? 'A doação voltou para o feed: você pode escolher outra ONG interessada.'
          : 'A doação voltou para o feed e pode ser negociada com outra ONG.',
        ...(p.reason ? ['Motivo informado:'] : []),
      ],
      quote: p.reason ?? undefined,
      cta: p.byNgo ? { label: 'Ver minhas doações', url: l.donations } : { label: 'Ver as doações', url: l.feed },
    }),

  donationCompleted: (p: { donorName: string; ngoName: string; itemTitle: string }, l: Links) =>
    render({
      subject: `Doação concluída: "${p.itemTitle}"`,
      greeting: hi(p.donorName),
      paragraphs: [
        `A ONG ${p.ngoName} confirmou que recebeu "${p.itemTitle}". Doação concluída!`,
        'Obrigado por fazer a doação chegar a quem precisa. A conversa fica guardada, só para leitura.',
      ],
      cta: { label: 'Publicar outra doação', url: l.newDonation },
    }),

  passwordChanged: (p: { name: string }, l: Links) =>
    render({
      subject: 'Sua senha foi alterada',
      greeting: hi(p.name),
      paragraphs: [
        'A senha da sua conta acabou de ser alterada, e as sessões abertas em outros aparelhos foram encerradas.',
        'Se foi você, está tudo certo. Se não foi, use "Esqueci a senha" na tela de login para criar uma senha nova agora.',
      ],
      cta: { label: 'Abrir o app', url: l.feed },
    }),

  reportCreated: (
    p: { adminName: string; reporterName: string; reportedName: string; itemTitle: string; reportId: string },
    l: Links,
  ) =>
    render({
      subject: `Nova denúncia sobre "${p.itemTitle}"`,
      greeting: hi(p.adminName),
      paragraphs: [`${p.reporterName} denunciou ${p.reportedName} na negociação da doação "${p.itemTitle}".`],
      cta: { label: 'Ver a denúncia', url: l.report(p.reportId) },
    }),

  accountDeleted: (p: { name: string }) =>
    render({
      subject: 'Conta excluída',
      greeting: hi(p.name),
      paragraphs: [
        'Sua conta foi excluída, como você pediu. Seus dados pessoais foram removidos.',
        'As doações já concluídas e as conversas delas ficam no histórico, sem o seu nome.',
      ],
      footnote: 'Se não foi você, responda a este e-mail.',
    }),
};
