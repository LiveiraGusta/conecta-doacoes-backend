import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../test/helpers/fake-db';
import type { EmailMessage } from '../../core/email';
import type { PasswordHasher } from '../../core/passwords';
import type { UserWithProfile } from '../../types';
import type { PasswordResetsRepository } from './password-resets.repository';
import { createPasswordResetService, hashResetToken } from './password-reset.service';

const USER = {
  id: 'u1',
  name: 'Marina <Souza>',
  email: 'marina@teste.dev',
  role: 'DONOR',
  ngo_profile: null,
} as unknown as UserWithProfile;

const hasher: PasswordHasher = { hash: async (p) => `h:${p}`, compare: async () => true };

function setup(opts: { user?: UserWithProfile | null; repo?: Partial<PasswordResetsRepository>; sendFails?: boolean } = {}) {
  const outbox: EmailMessage[] = [];
  const resetsRepo = {
    createdRecently: vi.fn(async () => false),
    replaceForUser: vi.fn(async () => {}),
    consume: vi.fn(async () => 'u1' as string | null),
    deleteOthers: vi.fn(async () => {}),
    ...opts.repo,
  };
  const authRepo = {
    findByEmail: vi.fn(async () => (opts.user === undefined ? USER : opts.user)),
    setPassword: vi.fn(async () => {}),
  };
  const onEmailError = vi.fn();
  const notifier = { notify: vi.fn(), drain: async () => {} };
  const service = createPasswordResetService({
    db: fakeDb(),
    authRepo,
    resetsRepo: resetsRepo as unknown as PasswordResetsRepository,
    hasher,
    mailer: {
      send: async (m) => {
        if (opts.sendFails) throw new Error('Resend fora do ar');
        outbox.push(m);
      },
    },
    appUrl: 'https://app.test',
    onEmailError,
    notifier,
  });
  return { service, outbox, resetsRepo, authRepo, onEmailError, notifier };
}

const tokenFrom = (m: EmailMessage) => new URL(m.text.match(/https:\S+/)![0]).searchParams.get('token')!;

describe('passwordResetService.requestReset', () => {
  it('e-mail desconhecido: não grava nem envia nada', async () => {
    const { service, outbox, resetsRepo } = setup({ user: null });
    await service.requestReset('ninguem@teste.dev');
    expect(resetsRepo.replaceForUser).not.toHaveBeenCalled();
    expect(outbox).toHaveLength(0);
  });

  it('grava só o hash do token e envia o link com o token em claro', async () => {
    const { service, outbox, resetsRepo } = setup();
    await service.requestReset(USER.email);
    expect(outbox).toHaveLength(1);
    const token = tokenFrom(outbox[0]!);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes em base64url
    expect(outbox[0]!.text).toContain('https://app.test/redefinir-senha?token=');
    expect(resetsRepo.replaceForUser).toHaveBeenCalledWith(expect.anything(), 'u1', hashResetToken(token), 30);
    expect(hashResetToken(token)).not.toBe(token);
    // nome escapado no HTML
    expect(outbox[0]!.html).toContain('Marina &lt;Souza&gt;');
  });

  it('pedido repetido dentro de 60 s não gera outro e-mail', async () => {
    const { service, outbox, resetsRepo } = setup({ repo: { createdRecently: async () => true } });
    await service.requestReset(USER.email);
    expect(resetsRepo.replaceForUser).not.toHaveBeenCalled();
    expect(outbox).toHaveLength(0);
  });

  it('falha no envio não vira erro para o cliente: só é registrada', async () => {
    const { service, onEmailError } = setup({ sendFails: true });
    await expect(service.requestReset(USER.email)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(onEmailError).toHaveBeenCalledWith(expect.any(Error)));
  });
});

describe('passwordResetService.resetPassword', () => {
  it('token inválido, expirado ou usado: INVALID_RESET_TOKEN sem mexer na senha', async () => {
    const { service, authRepo, notifier } = setup({ repo: { consume: async () => null } });
    await expect(service.resetPassword('qualquer', 'NovaSenha9')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_RESET_TOKEN',
    });
    expect(authRepo.setPassword).not.toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('consome pelo hash, grava a senha nova e invalida os outros links', async () => {
    const { service, authRepo, resetsRepo } = setup();
    await service.resetPassword('tok', 'NovaSenha9');
    expect(resetsRepo.consume).toHaveBeenCalledWith(expect.anything(), hashResetToken('tok'));
    expect(authRepo.setPassword).toHaveBeenCalledWith(expect.anything(), 'u1', 'h:NovaSenha9');
    expect(resetsRepo.deleteOthers).toHaveBeenCalledWith(expect.anything(), 'u1', hashResetToken('tok'));
  });

  it('agenda o aviso de senha alterada para o dono da conta', async () => {
    const { service, notifier } = setup();
    await service.resetPassword('tok', 'NovaSenha9');
    expect(notifier.notify).toHaveBeenCalledWith({ type: 'password.changed', userId: 'u1' });
  });
});
