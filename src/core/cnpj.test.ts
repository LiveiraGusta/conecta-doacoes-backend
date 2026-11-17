import { describe, expect, it } from 'vitest';
import { normalizeCnpj } from './cnpj';

describe('normalizeCnpj', () => {
  it.each(['11.222.333/0001-81', '11222333000181', ' 11.222.333/0001-81 '.trim()])('aceita %s e devolve mascarado', (v) => {
    expect(normalizeCnpj(v)).toBe('11.222.333/0001-81');
  });

  it.each([
    ['dígito verificador errado', '11.222.333/0001-82'],
    ['13 dígitos', '1122233300018'],
    ['todos iguais', '11111111111111'],
    ['letras', '11.222.333/0001-8A'],
    ['vazio', ''],
  ])('recusa %s', (_caso, v) => {
    expect(normalizeCnpj(v)).toBeNull();
  });
});
