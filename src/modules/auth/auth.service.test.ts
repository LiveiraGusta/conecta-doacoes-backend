import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../test/helpers/fake-db';
import { fakeStorage } from '../../../test/helpers/fake-storage';
import type { PasswordHasher } from '../../core/passwords';
import type { NgoProfile, User } from '../../types';
import type { AuthRepository } from './auth.repository';
import { createAuthService } from './auth.service';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Marina Souza',
  email: 'marina@teste.dev',
  password_hash: 'h:Senha1234',
  role: 'DONOR',
  city: 'São Paulo',
  state: 'SP',
  created_at: new Date(),
};

const PDF = Buffer.from('%PDF-1.4 conteudo');
const NGO_INPUT = {
  name: 'ONG Salvadora',
  email: 'contato@ong.dev',
  password: 'Senha1234',
  city: 'São Paulo',
  state: 'SP',
  cnpj: '11.222.333/0001-81',
};

const hasher: PasswordHasher = {
  hash: async (p) => `h:${p}`,
  compare: vi.fn(async (p: string, h: string) => h === `h:${p}`),
};

function setup(repo: Partial<AuthRepository> = {}) {
  const storage = fakeStorage();
  const authRepo = {
    emailExists: async () => false,
    cnpjExists: async () => false,
    findByEmail: async () => null,
    findById: async () => null,
    insertUser: async (_q: unknown, u: Partial<User>) => ({ ...USER, ...u }) as User,
    insertNgoProfile: async (_q: unknown, p: Partial<NgoProfile>) =>
      ({ id: 'p1', status: 'PENDENTE_APROVACAO', rejection_reason: null, ...p }) as NgoProfile,
    ...repo,
  } as unknown as AuthRepository;
  const signToken = vi.fn(() => 'token-assinado');
  const notifier = { notify: vi.fn(), drain: async () => {} };
  const service = createAuthService({ db: fakeDb(), authRepo, storage, hasher, signToken, notifier });
  return { service, storage, signToken, notifier };
}

describe('authService.registerDonor', () => {
  it('cria doador com senha em hash e devolve token', async () => {
    const insertUser = vi.fn(async (_q: unknown, u: Partial<User>) => ({ ...USER, ...u }) as User);
    const { service, signToken } = setup({ insertUser } as Partial<AuthRepository>);
    const result = await service.registerDonor({ ...NGO_INPUT, name: 'Marina' });
    expect(insertUser.mock.calls[0]![1]).toMatchObject({ role: 'DONOR', password_hash: 'h:Senha1234' });
    expect(signToken).toHaveBeenCalledWith({ sub: USER.id, role: 'DONOR' });
    expect(result).toMatchObject({ token: 'token-assinado', user: { ngo_profile: null } });
  });

  it('EMAIL_TAKEN quando o e-mail já existe', async () => {
    const { service, notifier } = setup({ emailExists: async () => true });
    await expect(service.registerDonor(NGO_INPUT)).rejects.toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('agenda o e-mail de boas-vindas', async () => {
    const { service, notifier } = setup();
    await service.registerDonor({ ...NGO_INPUT, name: 'Marina' });
    expect(notifier.notify).toHaveBeenCalledWith({ type: 'donor.registered', userId: USER.id });
  });
});

describe('authService.registerNgo', () => {
  it('sobe o documento em <user_id>/<uuid>.pdf e grava o caminho no perfil', async () => {
    const { service, storage } = setup();
    const result = await service.registerNgo(NGO_INPUT, [PDF]);
    const [key] = [...storage.files.keys()];
    expect(key).toMatch(/^docs\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/);
    expect(result.user.ngo_profile).toMatchObject({ status: 'PENDENTE_APROVACAO', document_url: key!.slice(5) });
    expect(key!.slice(5).startsWith(result.user.id)).toBe(true);
  });

  it.each([
    ['nenhum documento', []],
    ['dois documentos', [PDF, PDF]],
    ['tipo não aceito (texto)', [Buffer.from('apenas texto')]],
  ])('INVALID_DOCUMENT com %s', async (_caso, docs) => {
    const { service, storage } = setup();
    await expect(service.registerNgo(NGO_INPUT, docs)).rejects.toMatchObject({ status: 400, code: 'INVALID_DOCUMENT' });
    expect(storage.files.size).toBe(0);
  });

  it('EMAIL_TAKEN e CNPJ_TAKEN antes de subir o arquivo', async () => {
    const a = setup({ emailExists: async () => true });
    await expect(a.service.registerNgo(NGO_INPUT, [PDF])).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
    const b = setup({ cnpjExists: async () => true });
    await expect(b.service.registerNgo(NGO_INPUT, [PDF])).rejects.toMatchObject({ status: 409, code: 'CNPJ_TAKEN' });
    expect(a.storage.files.size + b.storage.files.size).toBe(0);
  });

  it('remove o documento do Storage se a transação falhar', async () => {
    const { service, storage } = setup({
      insertNgoProfile: async () => {
        throw Object.assign(new Error('duplicate'), { code: '23505', constraint_name: 'ngo_profiles_cnpj_key' });
      },
    });
    await expect(service.registerNgo(NGO_INPUT, [PDF])).rejects.toMatchObject({ code: '23505' });
    expect(storage.files.size).toBe(0);
  });
});

describe('authService.login', () => {
  it('INVALID_CREDENTIALS para e-mail inexistente, ainda comparando contra um hash fixo', async () => {
    const { service } = setup({ findByEmail: async () => null });
    vi.mocked(hasher.compare).mockClear();
    await expect(service.login('nao@existe.dev', 'Senha1234')).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIALS',
    });
    expect(hasher.compare).toHaveBeenCalledTimes(1);
  });

  it('INVALID_CREDENTIALS para senha errada (mesma resposta)', async () => {
    const { service } = setup({ findByEmail: async () => ({ ...USER, ngo_profile: null }) });
    await expect(service.login(USER.email, 'Errada123')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('devolve token e usuário com a senha certa', async () => {
    const { service } = setup({ findByEmail: async () => ({ ...USER, ngo_profile: null }) });
    await expect(service.login(USER.email, 'Senha1234')).resolves.toMatchObject({ token: 'token-assinado' });
  });
});

describe('authService.me', () => {
  it('UNAUTHORIZED se o usuário sumiu', async () => {
    const { service } = setup();
    await expect(service.me(USER.id)).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });
});

describe('authService.registerNgo — e-mails', () => {
  it('agenda a confirmação para a ONG e o aviso aos administradores', async () => {
    const { service, notifier } = setup();
    await service.registerNgo(NGO_INPUT, [PDF]);
    expect(notifier.notify).toHaveBeenCalledWith({ type: 'ngo.registered', userId: expect.any(String) });
  });

  it('cadastro recusado não gera e-mail', async () => {
    const { service, notifier } = setup({ cnpjExists: async () => true });
    await expect(service.registerNgo(NGO_INPUT, [PDF])).rejects.toMatchObject({ code: 'CNPJ_TAKEN' });
    expect(notifier.notify).not.toHaveBeenCalled();
  });
});
