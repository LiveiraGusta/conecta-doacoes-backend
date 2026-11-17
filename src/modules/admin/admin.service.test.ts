import { describe, expect, it, vi } from 'vitest';
import { fakeStorage } from '../../../test/helpers/fake-storage';
import type { Db } from '../../core/db';
import type { AdminNgoRow, AdminRepository } from './admin.repository';
import { createAdminService } from './admin.service';

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

const setup = (repo: Partial<AdminRepository>) =>
  createAdminService({
    db: { sql: {} as Db['sql'] },
    adminRepo: repo as AdminRepository,
    storage: fakeStorage(),
  });

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
