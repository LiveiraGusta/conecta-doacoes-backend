/** Envio de e-mail transacional. Em produção, Resend; em dev sem chave, só loga; nos testes, fake em memória. */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

/** API HTTP do Resend (https://resend.com/docs/api-reference/emails/send-email), sem SDK. */
export function createResendMailer(opts: { apiKey: string; from: string; fetch?: typeof fetch }): Mailer {
  const doFetch = opts.fetch ?? fetch;
  return {
    async send(message) {
      const res = await doFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: opts.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Resend respondeu ${res.status}: ${body.slice(0, 300)}`);
      }
    },
  };
}

/** Dev sem RESEND_API_KEY: o e-mail (com o link) aparece no log do servidor. */
export function createLogMailer(log: { info(obj: object, msg: string): void }): Mailer {
  return {
    async send(message) {
      log.info({ to: message.to, subject: message.subject, text: message.text }, 'E-mail (não enviado: sem RESEND_API_KEY)');
    },
  };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function passwordResetEmail(p: { to: string; name: string; link: string; minutes: number }): EmailMessage {
  const name = escapeHtml(p.name);
  const link = escapeHtml(p.link);
  return {
    to: p.to,
    subject: 'Redefinição de senha — Conecta Doações',
    text: [
      `Olá, ${p.name}!`,
      '',
      'Recebemos um pedido para redefinir a senha da sua conta no Conecta Doações.',
      `Para criar uma senha nova, abra o link abaixo (vale por ${p.minutes} minutos e só pode ser usado uma vez):`,
      '',
      p.link,
      '',
      'Se não foi você, ignore este e-mail: sua senha continua a mesma.',
    ].join('\n'),
    html: `<!doctype html>
<html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.5">
  <p>Olá, ${name}!</p>
  <p>Recebemos um pedido para redefinir a senha da sua conta no <strong>Conecta Doações</strong>.</p>
  <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#16a34a;color:#fff;border-radius:6px;text-decoration:none">Criar senha nova</a></p>
  <p style="font-size:13px;color:#6b7280">O link vale por ${p.minutes} minutos e só pode ser usado uma vez.
  Se o botão não funcionar, copie e cole no navegador:<br>${link}</p>
  <p style="font-size:13px;color:#6b7280">Se não foi você, ignore este e-mail: sua senha continua a mesma.</p>
</body></html>`,
  };
}
