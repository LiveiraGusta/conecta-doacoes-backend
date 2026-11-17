-- 002_events_reports_indexes.sql (Spec do Backend, sem mudanças)
ALTER TABLE items ADD COLUMN completed_at TIMESTAMPTZ;

CREATE TABLE item_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  from_status VARCHAR(30),
  to_status VARCHAR(30) NOT NULL,
  actor_id UUID REFERENCES users(id),
  ngo_id UUID REFERENCES users(id),        -- ONG envolvida na negociação
  reason TEXT,                             -- motivo opcional do cancelamento
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Denúncias: tabela criada agora, rotas ficam para a V1.1.
CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES users(id),
  reported_id UUID NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'ABERTA' CHECK (status IN ('ABERTA', 'RESOLVIDA')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_items_feed ON items (state, city, status, created_at DESC);
CREATE INDEX idx_items_donor ON items (donor_id);
CREATE INDEX idx_interests_item ON item_interests (item_id);
CREATE INDEX idx_interests_ngo ON item_interests (ngo_id);
CREATE INDEX idx_messages_item ON chat_messages (item_id, created_at);
CREATE INDEX idx_photos_item ON item_photos (item_id);
CREATE UNIQUE INDEX idx_ngo_profiles_user ON ngo_profiles (user_id);
