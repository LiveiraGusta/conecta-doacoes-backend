-- 003_profile.sql — Módulo Perfil (V1.1)
ALTER TABLE users ADD COLUMN updated_at TIMESTAMPTZ;
-- Tokens emitidos antes desta data são recusados (troca e recuperação de senha).
ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ;
-- Conta excluída por anonimização: o hook de autenticação e o login tratam como inexistente.
ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;
CREATE INDEX idx_users_active ON users (id) WHERE deleted_at IS NULL;
