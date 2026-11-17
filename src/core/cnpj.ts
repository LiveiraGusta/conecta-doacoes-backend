const W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

const checkDigit = (digits: number[], weights: number[]) => {
  const sum = weights.reduce((acc, w, i) => acc + w * (digits[i] ?? 0), 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
};

/**
 * Aceita CNPJ com ou sem máscara, confere os dígitos verificadores
 * e devolve no formato 12.345.678/0001-99. Inválido → null.
 */
export function normalizeCnpj(input: string): string | null {
  if (!/^[\d./\-\s]+$/.test(input)) return null;
  const raw = input.replace(/\D/g, '');
  if (raw.length !== 14 || /^(\d)\1{13}$/.test(raw)) return null;

  const digits = [...raw].map(Number);
  if (checkDigit(digits, W1) !== digits[12] || checkDigit(digits, W2) !== digits[13]) return null;

  return raw.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}
