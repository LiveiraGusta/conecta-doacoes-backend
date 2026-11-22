import { describe, expect, it, vi } from 'vitest';
import { fakeStorage } from '../../../test/helpers/fake-storage';
import type { Db } from '../../core/db';
import type { AdminNgoRow, AdminRepository } from './admin.repository';
import { createAdminService } from './admin.service';
import type { NgoProfile } from '../../types';

const ROW: AdminNgoRow = {
  ngo_profile_id: 'p1',
  user_id: 'u1',
  name: 'ONG',
  email: 'ong@teste.dev',
  city: 'São Paulo',
  state: 'SP',
  cnpj: '11.222.333/0001-81',
  website: null,
  document_path: 'u1/doc.pdf',
  status: 'PENDENTE_APROVACAO',
  rejection_reason: null,
  created_at: new Date(),
};

const notifier = { notify: vi.fn(), drain: async () => {} };

const setup = (repo: Partial<AdminRepository>) => {
  notifier.notify.mockClear();
  return createAdminService({
    db: { sql: {} as Db['sql'] },
    adminRepo: repo as AdminRepository,
    storage: fakeStorage(),
    notifier,
  });
};

describe('adminService', () => {
  it('troca o caminho do documento por URL assinada de 10 minutos', async () => {
    const service = setup({ listNgos: async () => ({ total: 1, rows: [ROW] }) });
    const { data } = await service.listNgos({ status: 'PENDENTE_APROVACAO', limit: 30, offset: 0 });
    expect(data[0]).not.toHaveProperty('document_path');
    expect(data[0]!.document_url).toBe('https://storage.test/ngo-docs/u1/doc.pdf?token=fake&expires=600');
  });

  it('NGO_NOT_FOUND quando o perfil não existe', async () => {
    const service = setup({ updateNgoStatus: async () => null });
    await expect(service.updateNgoStatus('x', 'ATIVO')).rejects.toMatchObject({ status: 404, code: 'NGO_NOT_FOUND' });
  });

  it('grava rejection_reason como null ao aprovar, mesmo se vier preenchido', async () => {
    const updateNgoStatus = vi.fn(async () => ({ id: 'p1', status: 'ATIVO', rejection_reason: null }) as never);
    const service = setup({ updateNgoStatus });
    await service.updateNgoStatus('p1', 'ATIVO', 'motivo que deve ser ignorado');
    expect(updateNgoStatus).toHaveBeenCalledWith(expect.anything(), 'p1', 'ATIVO', null);
  });
});

describe('adminService — e-mails para a ONG', () => {
  const profile = { id: 'p1', user_id: 'n1', status: 'ATIVO', rejection_reason: null } as NgoProfile;

  it('aprovação avisa a ONG', async () => {
    await setup({ updateNgoStatus: async () => profile }).updateNgoStatus('p1', 'ATIVO');
    expect(notifier.notify).toHaveBeenCalledWith({ type: 'ngo.approved', userId: 'n1' });
  });

  it('rejeição avisa a ONG com o motivo', async () => {
    const rejected = { ...profile, status: 'REJEITADO', rejection_reason: 'Documento ilegível' } as NgoProfile;
    await setup({ updateNgoStatus: async () => rejected }).updateNgoStatus('p1', 'REJEITADO', 'Documento ilegível');
    expect(notifier.notify).toHaveBeenCalledWith({ type: 'ngo.rejected', userId: 'n1', reason: 'Documento ilegível' });
  });

  it('ONG inexistente: erro e nenhum e-mail', async () => {
    await expect(setup({ updateNgoStatus: async () => null }).updateNgoStatus('x', 'ATIVO')).rejects.toMatchObject({
      code: 'NGO_NOT_FOUND',
    });
    expect(notifier.notify).not.toHaveBeenCalled();
  });
});
