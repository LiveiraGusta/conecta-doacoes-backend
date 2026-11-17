import { describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../test/helpers/fake-db';
import { fakeStorage } from '../../../test/helpers/fake-storage';
import type { PasswordHasher } from '../../core/passwords';
import type { AuthUser, UserWithProfile } from '../../types';
import type { ProfileRepository } from './profile.repository';
import { createProfileService } from './profile.service';

const DONOR: AuthUser = { id: 'd1', role: 'DONOR', city: 'São Paulo', state: 'SP', ngoStatus: null };
const NGO: AuthUser = { id: 'n1', role: 'NGO', city: 'São Paulo', state: 'SP', ngoStatus: 'REJEITADO' };
const PDF = Buffer.from('%PDF-1.4');

const self: UserWithProfile = {
  id: 'd1',
  name: 'Marina',
  email: 'm@t.dev',
  password_hash: 'h:Senha1234',
  role: 'DONOR',
  city: 'São Paulo',
  state: 'SP',
  created_at: new Date(),
  ngo_profile: null,
};

const hasher: PasswordHasher = { hash: async (p) => `h:${p}`, compare: async (p, h) => h === `h:${p}` };

function setup(repo: Partial<ProfileRepository> = {}) {
  const storage = fakeStorage();
  const profileRepo = {
    updateUser: vi.fn(async () => {}),
    updateWebsite: vi.fn(async () => {}),
    setPassword: vi.fn(async () => {}),
    replaceDocumentUnlessActive: vi.fn(async () => ({ replaced: true as const, oldPath: 'n1/old.pdf' })),
    hasActiveNegotiations: vi.fn(async () => false),
    deleteAvailableItemsOfDonor: vi.fn(async () => ['https://storage.test/items/i1/a.webp']),
    deleteOpenInterestsOfNgo: vi.fn(async () => {}),
    deleteNgoProfile: vi.fn(async () => 'n1/doc.pdf'),
    anonymize: vi.fn(async () => {}),
    ...repo,
  } as unknown as ProfileRepository & Record<string, ReturnType<typeof vi.fn>>;
  const service = createProfileService({
    db: fakeDb(),
    profileRepo,
    authRepo: { findById: async () => self },
    storage,
    hasher,
  });
  return { service, storage, profileRepo };
}

describe('profileService.update', () => {
  it('doador não pode ter site', async () => {
    await expect(setup().service.update(DONOR, { website: 'https://x.dev' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ path: 'website', message: 'Só ONGs têm site no perfil' }],
    });
  });

  it('ONG atualiza só o site sem tocar em users', async () => {
    const { service, profileRepo } = setup();
    await service.update(NGO, { website: null });
    expect(profileRepo.updateWebsite).toHaveBeenCalledWith(expect.anything(), 'n1', null);
    expect(profileRepo.updateUser).not.toHaveBeenCalled();
  });
});

describe('profileService.changePassword', () => {
  it('INVALID_CURRENT_PASSWORD e SAME_PASSWORD', async () => {
    await expect(setup().service.changePassword(DONOR, 'Errada123', 'Nova12345')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_CURRENT_PASSWORD',
    });
    await expect(setup().service.changePassword(DONOR, 'Senha1234', 'Senha1234')).rejects.toMatchObject({
      status: 400,
      code: 'SAME_PASSWORD',
    });
  });

  it('grava o hash novo', async () => {
    const { service, profileRepo } = setup();
    await service.changePassword(DONOR, 'Senha1234', 'Nova12345');
    expect(profileRepo.setPassword).toHaveBeenCalledWith(expect.anything(), 'd1', 'h:Nova12345');
  });
});

describe('profileService.resubmitDocument', () => {
  it('NGO_ALREADY_ACTIVE para ONG aprovada, sem subir nada', async () => {
    const { service, storage } = setup();
    await expect(service.resubmitDocument({ ...NGO, ngoStatus: 'ATIVO' }, [PDF])).rejects.toMatchObject({
      status: 409,
      code: 'NGO_ALREADY_ACTIVE',
    });
    expect(storage.files.size).toBe(0);
  });

  it('INVALID_DOCUMENT com arquivo que não é PDF/imagem', async () => {
    await expect(setup().service.resubmitDocument(NGO, [Buffer.from('texto')])).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT',
    });
  });

  it('troca o arquivo: o novo fica, o antigo sai depois do commit', async () => {
    const { service, storage } = setup();
    await storage.upload('docs', 'n1/old.pdf', PDF, 'application/pdf');
    await service.resubmitDocument(NGO, [PDF]);
    const keys = [...storage.files.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^docs\/n1\/[0-9a-f-]+\.pdf$/);
  });

  it('se a ONG foi aprovada no meio do caminho, apaga o arquivo novo e responde NGO_ALREADY_ACTIVE', async () => {
    const { service, storage } = setup({
      replaceDocumentUnlessActive: async () => ({ replaced: false, isActive: true }),
    });
    await expect(service.resubmitDocument(NGO, [PDF])).rejects.toMatchObject({ code: 'NGO_ALREADY_ACTIVE' });
    expect(storage.files.size).toBe(0);
  });
});

describe('profileService.deleteAccount', () => {
  it('INVALID_CURRENT_PASSWORD e HAS_ACTIVE_NEGOTIATIONS bloqueiam antes de mexer em qualquer coisa', async () => {
    const a = setup();
    await expect(a.service.deleteAccount(DONOR, 'Errada123')).rejects.toMatchObject({ code: 'INVALID_CURRENT_PASSWORD' });
    const b = setup({ hasActiveNegotiations: async () => true });
    await expect(b.service.deleteAccount(DONOR, 'Senha1234')).rejects.toMatchObject({
      status: 409,
      code: 'HAS_ACTIVE_NEGOTIATIONS',
    });
    expect(a.profileRepo.anonymize).not.toHaveBeenCalled();
    expect(b.profileRepo.anonymize).not.toHaveBeenCalled();
  });

  it('doador: apaga itens disponíveis e as fotos deles, e anonimiza', async () => {
    const { service, storage, profileRepo } = setup();
    await storage.upload('items', 'i1/a.webp', PDF, 'image/webp');
    await service.deleteAccount(DONOR, 'Senha1234');
    expect(profileRepo.deleteAvailableItemsOfDonor).toHaveBeenCalled();
    expect(profileRepo.deleteNgoProfile).not.toHaveBeenCalled();
    expect(profileRepo.anonymize).toHaveBeenCalledWith(expect.anything(), 'd1');
    expect(storage.files.size).toBe(0);
  });

  it('ONG: apaga curtidas abertas, o perfil e o documento', async () => {
    const { service, storage, profileRepo } = setup();
    await storage.upload('docs', 'n1/doc.pdf', PDF, 'application/pdf');
    await service.deleteAccount(NGO, 'Senha1234');
    expect(profileRepo.deleteOpenInterestsOfNgo).toHaveBeenCalled();
    expect(profileRepo.deleteAvailableItemsOfDonor).not.toHaveBeenCalled();
    expect(storage.files.size).toBe(0);
  });
});
