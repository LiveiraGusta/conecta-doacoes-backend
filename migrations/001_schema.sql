-- 001_schema.sql
-- Schema base do MVP, reconstruído a partir do openapi.yaml, da Spec do Backend e da Spec de Endpoints.
-- gen_random_uuid() é nativo no Postgres 13+ (Supabase e docker local), sem extensão.

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(10) NOT NULL CHECK (role IN ('DONOR', 'NGO', 'ADMIN')),
  city VARCHAR(100) NOT NULL,
  state CHAR(2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_email_key UNIQUE (email)
);

CREATE TABLE ngo_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cnpj VARCHAR(18) NOT NULL,                       -- sempre mascarado: 12.345.678/0001-99
  website VARCHAR(255),
  document_url TEXT NOT NULL,                      -- caminho no bucket privado ngo-docs
  status VARCHAR(30) NOT NULL DEFAULT 'PENDENTE_APROVACAO'
    CHECK (status IN ('PENDENTE_APROVACAO', 'ATIVO', 'REJEITADO')),
  rejection_reason TEXT,
  CONSTRAINT ngo_profiles_cnpj_key UNIQUE (cnpj)
);

CREATE TABLE items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  donor_id UUID NOT NULL REFERENCES users(id),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(20) NOT NULL CHECK (category IN ('ROUPAS', 'BRINQUEDOS', 'ALIMENTOS', 'LIVROS')),
  city VARCHAR(100) NOT NULL,
  state CHAR(2) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'DISPONIVEL'
    CHECK (status IN ('DISPONIVEL', 'EM_PROGRESSO', 'DOADO')),  -- CANCELADO só existe em item_events
  selected_ngo_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE item_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  photo_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE item_interests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  ngo_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT item_interests_item_id_ngo_id_key UNIQUE (item_id, ngo_id)
);

CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id),
  receiver_id UUID NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
