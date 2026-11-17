import sharp from 'sharp';
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
    updateBio: vi.fn(async () => {}),
    updateNgoProfile: vi.fn(async () => {}),
    upsertPreferences: vi.fn(async (_q: unknown, _id: string, p: unknown) => p),
    replaceDocumentUnlessActive: vi.fn(async () => ({ replaced: true as const, oldPath: 'n1/old.pdf' })),
    hasActiveNegotiations: vi.fn(async () => false),
    deleteAvailableItemsOfDonor: vi.fn(async () => ['https://storage.test/items/i1/a.webp']),
    deleteOpenInterestsOfNgo: vi.fn(async () => {}),
    deleteNgoProfile: vi.fn(async () => 'n1/doc.pdf'),
    anonymize: vi.fn(async () => {}),
    ...repo,
  } as unknown as ProfileRepository & Record<string, ReturnType<typeof vi.fn>>;
  const authRepo = { findById: async () => self, setPassword: vi.fn(async () => {}) };
  const service = createProfileService({ db: fakeDb(), profileRepo, authRepo, storage, hasher });
  return { service, storage, profileRepo, authRepo };
}

describe('profileService.update', () => {
  it('doador não pode enviar campos de ONG: um erro por campo', async () => {
    await expect(
      setup().service.update(DONOR, { website: 'https://x.dev', phone: '11987654321', address: null }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [
        { path: 'website', message: 'Campo disponível só para ONGs' },
        { path: 'phone', message: 'Campo disponível só para ONGs' },
        { path: 'address', message: 'Campo disponível só para ONGs' },
      ],
    });
  });

  it('endereço null apaga as 5 colunas; objeto grava todas, com complemento ausente como null', async () => {
    const { service, profileRepo } = setup();
    await service.update(NGO, { address: null });
    expect(profileRepo.updateNgoProfile).toHaveBeenLastCalledWith(expect.anything(), 'n1', {
      phone: undefined,
      instagram: undefined,
      accepted_categories: undefined,
      cep: null,
      street: null,
      number: null,
      complement: null,
      neighborhood: null,
    });
    await service.update(NGO, { address: { cep: '01310100', street: 'Av. Paulista', number: '1000', neighborhood: 'Bela Vista' } });
    expect(profileRepo.updateNgoProfile).toHaveBeenLastCalledWith(
      expect.anything(),
      'n1',
      expect.objectContaining({ cep: '01310100', street: 'Av. Paulista', complement: null }),
    );
  });

  it('bio vale para doador e não mexe no perfil de ONG', async () => {
    const { service, profileRepo } = setup();
    await service.update(DONOR, { bio: 'Doo o que não uso mais.' });
    expect(profileRepo.updateBio).toHaveBeenCalledWith(expect.anything(), 'd1', 'Doo o que não uso mais.');
    expect(profileRepo.updateNgoProfile).not.toHaveBeenCalled();
  });

  it('ONG atualiza só o site sem tocar em users', async () => {
    const { service, profileRepo } = setup();
    await service.update(NGO, { website: null });
    expect(profileRepo.updateWebsite).toHaveBeenCalledWith(expect.anything(), 'n1', null);
    expect(profileRepo.updateUser).not.toHaveBeenCalled();
  });
});

describe('profileService foto de perfil', () => {
  const png = () => sharp({ create: { width: 40, height: 20, channels: 3, background: '#0af' } }).png().toBuffer();

  it('se gravar a URL falhar, a imagem nova sai do bucket e o erro sobe', async () => {
    const { service, storage } = setup({ setAvatarUrl: vi.fn(async () => { throw new Error('banco fora'); }) });
    await expect(service.setAvatar(DONOR, [await png()])).rejects.toThrow('banco fora');
    expect(storage.files.size).toBe(0);
  });

  it('INVALID_PHOTO sem arquivo ou com 2', async () => {
    const { service } = setup();
    await expect(service.setAvatar(DONOR, [])).rejects.toMatchObject({ code: 'INVALID_PHOTO' });
    await expect(service.setAvatar(DONOR, [await png(), await png()])).rejects.toMatchObject({ code: 'INVALID_PHOTO' });
  });
});

describe('profileService preferências', () => {
  it('sem linha gravada devolve os padrões', async () => {
    expect(await setup().service.getPreferences(DONOR)).toEqual({ theme_color: 'AZUL', theme_mode: 'SYSTEM', show_donations: false });
  });

  it('mescla o patch com os padrões e grava a linha completa', async () => {
    const { service, profileRepo } = setup();
    const result = await service.updatePreferences(DONOR, { theme_mode: 'DARK' });
    expect(result).toEqual({ theme_color: 'AZUL', theme_mode: 'DARK', show_donations: false });
    expect(profileRepo.upsertPreferences).toHaveBeenCalledWith(expect.anything(), 'd1', result);
  });

  it('show_donations é só do doador', async () => {
    await expect(setup().service.updatePreferences(NGO, { show_donations: true })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ path: 'show_donations' }],
    });
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
    const { service, authRepo } = setup();
    await service.changePassword(DONOR, 'Senha1234', 'Nova12345');
    expect(authRepo.setPassword).toHaveBeenCalledWith(expect.anything(), 'd1', 'h:Nova12345');
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
