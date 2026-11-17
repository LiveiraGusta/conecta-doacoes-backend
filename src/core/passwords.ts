import bcrypt from 'bcrypt';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  compare(password: string, hash: string): Promise<boolean>;
}

const COST = 10;

export const bcryptHasher: PasswordHasher = {
  hash: (password) => bcrypt.hash(password, COST),
  compare: (password, hash) => bcrypt.compare(password, hash),
};

/** Regra de senha do contrato: 8–72 caracteres (limite do bcrypt), ao menos 1 letra e 1 número. */
export const PASSWORD_RULE = {
  min: 8,
  max: 72,
  test: (p: string) => /[A-Za-z]/.test(p) && /\d/.test(p),
  message: 'A senha precisa de ao menos 1 letra e 1 número',
};
