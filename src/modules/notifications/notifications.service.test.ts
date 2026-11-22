import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../core/db';
import type { EmailMessage } from '../../core/email';
import type { Contact, ItemRef, NotificationsRepository } from './notifications.repository';
import { createNotifier, noopNotifier, type NotificationEvent } from './notifications.service';

const donor: Contact = { id: 'd1', name: 'Marina Souza', email: 'marina@teste.dev', role: 'DONOR' };
const ngo: Contact = { id: 'n1', name: 'Casa Esperança', email: 'casa@ong.dev', role: 'NGO' };
const admins: Contact[] = [
  { id: 'a1', name: 'Ana Admin', email: 'ana@admin.dev', role: 'ADMIN' },
  { id: 'a2', name: 'Beto Admin', email: 'beto@admin.dev', role: 'ADMIN' },
];
const item: ItemRef = { id: 'i1', title: 'Casaco infantil', donor_id: 'd1' };

function setup(opts: { contacts?: Contact[]; item?: ItemRef | null; failFor?: string; repoFails?: boolean } = {}) {
  const outbox: EmailMessage[] = [];
  const people = opts.contacts ?? [donor, ngo];
  const repo: NotificationsRepository = {
    findContacts: vi.fn(async (_q, ids: string[]) => {
      if (opts.repoFails) throw new Error('banco fora do ar');
      return people.filter((p) => ids.includes(p.id));
    }),
    findAdmins: vi.fn(async () => admins),
    findItem: vi.fn(async () => (opts.item === undefined ? item : opts.item)),
  };
  const onError = vi.fn();
  const notifier = createNotifier({
    db: { sql: {} as Db['sql'] },
    repo,
    mailer: {
      send: async (m) => {
        await Promise.resolve(); // envio de verdade é assíncrono
        if (m.to === opts.failFor) throw new Error('provedor recusou');
        outbox.push(m);
      },
    },
    appUrl: 'https://app.test',
    onError,
  });
  const run = async (event: NotificationEvent) => {
    notifier.notify(event);
    await notifier.drain();
    return outbox;
  };
  return { notifier, outbox, repo, onError, run };
}

describe('notifier — quem recebe cada e-mail', () => {
  it('doador cadastrado recebe boas-vindas com link para publicar', async () => {
    const [mail] = await setup().run({ type: 'donor.registered', userId: 'd1' });
    expect(mail).toMatchObject({ to: donor.email, subject: expect.stringContaining('Boas-vindas') });
    expect(mail!.text).toContain('https://app.test/donations/new');
  });

  it('ONG cadastrada: confirmação para a ONG e aviso para cada administrador', async () => {
    const mails = await setup().run({ type: 'ngo.registered', userId: 'n1' });
    expect(mails.map((m) => m.to).sort()).toEqual([admins[0]!.email, admins[1]!.email, ngo.email].sort());
    expect(mails.find((m) => m.to === ngo.email)!.subject).toContain('Cadastro recebido');
    const toAdmin = mails.find((m) => m.to === admins[0]!.email)!;
    expect(toAdmin.subject).toContain('Nova ONG para análise: Casa Esperança');
    expect(toAdmin.text).toContain('https://app.test/admin/ngos');
  });

  it('documento reenviado avisa só os administradores', async () => {
    const mails = await setup().run({ type: 'ngo.document_resubmitted', userId: 'n1' });
    expect(mails.map((m) => m.to).sort()).toEqual([admins[0]!.email, admins[1]!.email].sort());
    expect(mails[0]!.subject).toContain('Documento reenviado');
  });

  it('ONG aprovada recebe o aviso com link para o feed', async () => {
    const [mail] = await setup().run({ type: 'ngo.approved', userId: 'n1' });
    expect(mail).toMatchObject({ to: ngo.email, subject: expect.stringContaining('ONG aprovada') });
    expect(mail!.text).toContain('https://app.test/feed');
  });

  it('ONG rejeitada recebe o motivo e o link para reenviar o documento', async () => {
    const [mail] = await setup().run({ type: 'ngo.rejected', userId: 'n1', reason: 'O documento está ilegível.' });
    expect(mail).toMatchObject({ to: ngo.email, subject: expect.stringContaining('não aprovado') });
    expect(mail!.text).toContain('O documento está ilegível.');
    expect(mail!.html).toContain('O documento está ilegível.');
    expect(mail!.text).toContain('https://app.test/profile');
  });

  it('interesse avisa o doador, com o nome da ONG e o link das interessadas', async () => {
    const [mail] = await setup().run({ type: 'interest.created', itemId: 'i1', ngoId: 'n1' });
    expect(mail).toMatchObject({ to: donor.email, subject: expect.stringContaining('Casaco infantil') });
    expect(mail!.text).toContain('Casa Esperança');
    expect(mail!.text).toContain('https://app.test/donations/i1/interests');
  });

  it('escolha avisa a ONG, com o link da conversa', async () => {
    const [mail] = await setup().run({ type: 'ngo.selected', itemId: 'i1', ngoId: 'n1' });
    expect(mail).toMatchObject({ to: ngo.email, subject: expect.stringContaining('foi escolhida') });
    expect(mail!.text).toContain('Marina Souza');
    expect(mail!.text).toContain('https://app.test/chats/i1');
  });

  it('cancelamento pelo doador avisa a ONG, com o motivo', async () => {
    const mails = await setup().run({
      type: 'negotiation.cancelled',
      itemId: 'i1',
      actorId: 'd1',
      counterpartId: 'n1',
      reason: 'Mudei de ideia',
    });
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: ngo.email, subject: expect.stringContaining('Negociação cancelada') });
    expect(mails[0]!.text).toContain('Marina Souza cancelou');
    expect(mails[0]!.text).toContain('Mudei de ideia');
  });

  it('cancelamento pela ONG avisa o doador e sugere escolher outra ONG', async () => {
    const [mail] = await setup().run({
      type: 'negotiation.cancelled',
      itemId: 'i1',
      actorId: 'n1',
      counterpartId: 'd1',
      reason: null,
    });
    expect(mail!.to).toBe(donor.email);
    expect(mail!.text).toContain('escolher outra ONG');
    expect(mail!.text).not.toContain('Motivo');
  });

  it('doação concluída avisa o doador', async () => {
    const [mail] = await setup().run({ type: 'donation.completed', itemId: 'i1', ngoId: 'n1' });
    expect(mail).toMatchObject({ to: donor.email, subject: expect.stringContaining('Doação concluída') });
    expect(mail!.text).toContain('Casa Esperança confirmou');
  });

  it('senha alterada gera aviso de segurança', async () => {
    const [mail] = await setup().run({ type: 'password.changed', userId: 'd1' });
    expect(mail).toMatchObject({ to: donor.email, subject: expect.stringContaining('senha foi alterada') });
    expect(mail!.text).toContain('Esqueci a senha');
  });

  it('denúncia avisa cada administrador, com o link da denúncia', async () => {
    const mails = await setup().run({ type: 'report.created', reportId: 'r1', itemId: 'i1', reporterId: 'd1', reportedId: 'n1' });
    expect(mails.map((m) => m.to).sort()).toEqual([admins[0]!.email, admins[1]!.email].sort());
    expect(mails[0]!.text).toContain('Marina Souza denunciou Casa Esperança');
    expect(mails[0]!.text).toContain('https://app.test/admin/reports/r1');
  });

  it('denúncia de anúncio avisa cada administrador, com o motivo e o link da denúncia', async () => {
    const mails = await setup().run({
      type: 'item.reported',
      reportId: 'r2',
      itemId: 'i1',
      reporterId: 'n1',
      category: 'GOLPE',
      hidden: false,
    });
    expect(mails.map((m) => m.to).sort()).toEqual([admins[0]!.email, admins[1]!.email].sort());
    expect(mails[0]!.subject).toContain('Anúncio denunciado: "Casaco infantil"');
    expect(mails[0]!.text).toContain('Casa Esperança denunciou o anúncio');
    expect(mails[0]!.text).toContain('Golpe ou fraude');
    expect(mails[0]!.text).toContain('continua no ar');
    expect(mails[0]!.text).toContain('https://app.test/admin/reports/r2');
  });

  it('denúncia que tirou o anúncio do ar muda o assunto', async () => {
    const [mail] = await setup().run({
      type: 'item.reported',
      reportId: 'r2',
      itemId: 'i1',
      reporterId: 'n1',
      category: 'NUDEZ',
      hidden: true,
    });
    expect(mail!.subject).toContain('Anúncio fora do ar por denúncias');
    expect(mail!.text).toContain('saiu do ar sozinho');
  });

  it('anúncio removido com negociação: doador recebe o motivo e a ONG, o aviso de encerramento', async () => {
    const mails = await setup().run({ type: 'item.removed', itemId: 'i1', reason: 'Foto imprópria', cancelledNgoId: 'n1' });
    expect(mails.map((m) => m.to).sort()).toEqual([ngo.email, donor.email].sort());
    const toDonor = mails.find((m) => m.to === donor.email)!;
    expect(toDonor.subject).toContain('Anúncio removido');
    expect(toDonor.text).toContain('Foto imprópria');
    expect(toDonor.text).toContain('negociação em andamento foi cancelada');
    const toNgo = mails.find((m) => m.to === ngo.email)!;
    expect(toNgo.subject).toContain('Negociação encerrada');
    expect(toNgo.text).not.toContain('Foto imprópria'); // o motivo é só para o doador
  });

  it('anúncio removido sem negociação: só o doador', async () => {
    const mails = await setup().run({ type: 'item.removed', itemId: 'i1', reason: 'Spam', cancelledNgoId: null });
    expect(mails.map((m) => m.to)).toEqual([donor.email]);
    expect(mails[0]!.text).not.toContain('negociação');
  });

  it('conta excluída usa o e-mail que veio no evento (o do banco já foi anonimizado)', async () => {
    const { run, repo } = setup();
    const [mail] = await run({ type: 'account.deleted', email: 'antigo@teste.dev', name: 'Marina' });
    expect(mail).toMatchObject({ to: 'antigo@teste.dev', subject: expect.stringContaining('Conta excluída') });
    expect(repo.findContacts).not.toHaveBeenCalled();
  });
});

describe('notifier — casos de borda', () => {
  it('pessoa excluída ou inexistente: nada é enviado', async () => {
    const { run } = setup({ contacts: [ngo] });
    expect(await run({ type: 'interest.created', itemId: 'i1', ngoId: 'n1' })).toHaveLength(0);
    expect(await run({ type: 'donor.registered', userId: 'd1' })).toHaveLength(0);
  });

  it('item inexistente: nada é enviado', async () => {
    expect(await setup({ item: null }).run({ type: 'ngo.selected', itemId: 'x', ngoId: 'n1' })).toHaveLength(0);
  });

  it('falha de um destinatário vai para onError e não impede os outros', async () => {
    const { run, onError } = setup({ failFor: admins[0]!.email });
    const mails = await run({ type: 'ngo.registered', userId: 'n1' });
    expect(mails.map((m) => m.to).sort()).toEqual([admins[1]!.email, ngo.email].sort());
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1]).toMatchObject({ type: 'ngo.registered' });
  });

  it('erro ao buscar destinatários vai para onError; notify nunca lança', async () => {
    const { notifier, onError } = setup({ repoFails: true });
    expect(() => notifier.notify({ type: 'ngo.approved', userId: 'n1' })).not.toThrow();
    await notifier.drain();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { type: 'ngo.approved', userId: 'n1' });
  });

  it('notify volta antes do envio; drain espera todos', async () => {
    const { notifier, outbox } = setup();
    notifier.notify({ type: 'ngo.approved', userId: 'n1' });
    notifier.notify({ type: 'donor.registered', userId: 'd1' });
    expect(outbox).toHaveLength(0);
    await notifier.drain();
    expect(outbox).toHaveLength(2);
  });

  it('escapa no HTML o texto vindo do usuário', async () => {
    const evil: Contact = { ...ngo, name: '<script>x</script>' };
    const [mail] = await setup({ contacts: [donor, evil] }).run({ type: 'interest.created', itemId: 'i1', ngoId: 'n1' });
    expect(mail!.html).not.toContain('<script>');
    expect(mail!.html).toContain('&lt;script&gt;');
    expect(mail!.text).toContain('<script>x</script>'); // texto puro não é HTML
  });

  it('noopNotifier não faz nada', async () => {
    expect(() => noopNotifier.notify({ type: 'donor.registered', userId: 'x' })).not.toThrow();
    await expect(noopNotifier.drain()).resolves.toBeUndefined();
  });
});
