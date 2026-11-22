import { describe, expect, it } from 'vitest';
import { issuedBeforePasswordChange } from './auth';

describe('issuedBeforePasswordChange', () => {
  const changedAt = new Date('2026-11-17T10:00:00.700Z'); // segundo 10:00:00
  const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

  it('sem troca de senha, nenhum token é recusado', () => {
    expect(issuedBeforePasswordChange(sec('2020-01-01T00:00:00Z'), null)).toBe(false);
  });

  it('token de um segundo anterior à troca é recusado', () => {
    expect(issuedBeforePasswordChange(sec('2026-11-17T09:59:59Z'), changedAt)).toBe(true);
  });

  it('token emitido no mesmo segundo da troca (o login logo depois) continua valendo', () => {
    expect(issuedBeforePasswordChange(sec('2026-11-17T10:00:00Z'), changedAt)).toBe(false);
  });

  it('token posterior à troca vale', () => {
    expect(issuedBeforePasswordChange(sec('2026-11-17T10:05:00Z'), changedAt)).toBe(false);
  });
});
