-- 008_profiles_preferences.sql — Página pessoal e preferências (integração com o frontend, fase 0.2b-1)

-- Descrição curta da página pessoal (doador e ONG).
ALTER TABLE users
  ADD COLUMN bio TEXT NULL,
  ADD CONSTRAINT users_bio_length CHECK (bio IS NULL OR char_length(bio) <= 500);

-- Dados públicos da ONG. Telefone e CEP só com dígitos; Instagram só o usuário, sem @.
ALTER TABLE ngo_profiles
  ADD COLUMN phone VARCHAR(11) NULL CHECK (phone IS NULL OR phone ~ '^[1-9][0-9]{9,10}$'),
  ADD COLUMN instagram VARCHAR(30) NULL CHECK (instagram IS NULL OR instagram ~ '^[a-z0-9._]{1,30}$'),
  ADD COLUMN accepted_categories VARCHAR(20)[] NOT NULL DEFAULT '{}'
    CHECK (accepted_categories <@ ARRAY['ROUPAS', 'BRINQUEDOS', 'ALIMENTOS', 'LIVROS']::VARCHAR(20)[]),
  ADD COLUMN cep CHAR(8) NULL CHECK (cep IS NULL OR cep ~ '^[0-9]{8}$'),
  ADD COLUMN street VARCHAR(200) NULL,
  ADD COLUMN number VARCHAR(20) NULL,
  ADD COLUMN complement VARCHAR(100) NULL,
  ADD COLUMN neighborhood VARCHAR(100) NULL,
  -- Endereço é tudo ou nada (o complemento é opcional).
  ADD CONSTRAINT ngo_profiles_address_complete CHECK (
    (cep IS NULL AND street IS NULL AND number IS NULL AND complement IS NULL AND neighborhood IS NULL)
    OR (cep IS NOT NULL AND street IS NOT NULL AND number IS NOT NULL AND neighborhood IS NOT NULL)
  );

-- Preferências de interface e privacidade. Sem linha = padrões (AZUL, SYSTEM, não mostrar doações).
CREATE TABLE user_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme_color VARCHAR(10) NOT NULL DEFAULT 'AZUL' CHECK (theme_color IN ('AZUL', 'VERDE', 'ROXO', 'LARANJA', 'ROSA')),
  theme_mode VARCHAR(10) NOT NULL DEFAULT 'SYSTEM' CHECK (theme_mode IN ('LIGHT', 'DARK', 'SYSTEM')),
  show_donations BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
