-- 010_item_moderation.sql — Denúncia de anúncio (conteúdo impróprio) e moderação de itens.

-- ── Moderação do item: independente de items.status (a máquina de estados da doação não muda) ──
-- VISIVEL: normal. OCULTO: saiu do ar sozinho por denúncias e aguarda o Admin. REMOVIDO: o Admin tirou do ar.
ALTER TABLE items ADD COLUMN moderation_status VARCHAR(10) NOT NULL DEFAULT 'VISIVEL'
  CHECK (moderation_status IN ('VISIVEL', 'OCULTO', 'REMOVIDO'));
-- Motivo mostrado ao doador quando o Admin remove.
ALTER TABLE items ADD COLUMN moderation_reason TEXT;
ALTER TABLE items ADD COLUMN moderated_at TIMESTAMPTZ;
-- NULL quando foi a ocultação automática.
ALTER TABLE items ADD COLUMN moderated_by UUID REFERENCES users(id);

-- ── Denúncias: de negociação (CHAT, já existia) ou de anúncio (ITEM) ──
ALTER TABLE reports ADD COLUMN kind VARCHAR(10) NOT NULL DEFAULT 'CHAT' CHECK (kind IN ('CHAT', 'ITEM'));
ALTER TABLE reports ALTER COLUMN kind DROP DEFAULT;
ALTER TABLE reports ADD COLUMN category VARCHAR(20)
  CHECK (category IN ('NUDEZ', 'ODIO', 'VIOLENCIA', 'GOLPE', 'PROIBIDO', 'SPAM', 'OUTRO'));
-- Na denúncia de anúncio o texto é opcional (salvo na categoria OUTRO, regra da API).
ALTER TABLE reports ALTER COLUMN reason DROP NOT NULL;
ALTER TABLE reports ADD CONSTRAINT reports_kind_fields_check CHECK (
  (kind = 'CHAT' AND reason IS NOT NULL AND category IS NULL) OR (kind = 'ITEM' AND category IS NOT NULL)
);
-- Desfecho da moderação de anúncio (as de CHAT ficam NULL).
ALTER TABLE reports ADD COLUMN resolution VARCHAR(20) CHECK (resolution IN ('ITEM_REMOVIDO', 'IMPROCEDENTE'));

-- Uma denúncia ABERTA por usuário, item e tipo (cada índice vira um 409 próprio no handler).
DROP INDEX reports_open_per_reporter_key;
CREATE UNIQUE INDEX reports_open_per_reporter_key ON reports (item_id, reporter_id)
  WHERE status = 'ABERTA' AND kind = 'CHAT';
CREATE UNIQUE INDEX reports_open_item_per_reporter_key ON reports (item_id, reporter_id)
  WHERE status = 'ABERTA' AND kind = 'ITEM';
