-- 004_password_resets.sql — Recuperação de senha (V1.1)
-- Só o hash SHA-256 do token fica no banco: um vazamento da tabela não permite redefinir senhas.
CREATE TABLE password_resets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT password_resets_token_hash_key UNIQUE (token_hash)
);

CREATE INDEX idx_password_resets_user ON password_resets (user_id, created_at DESC);
