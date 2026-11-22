-- 005_reports.sql — Denúncias (V1.1). A tabela veio na 002; aqui entram regras e auditoria.
ALTER TABLE reports ALTER COLUMN status SET NOT NULL;
ALTER TABLE reports ALTER COLUMN created_at SET NOT NULL;

-- Quem resolveu e quando (auditoria da moderação).
ALTER TABLE reports ADD COLUMN resolved_at TIMESTAMPTZ;
ALTER TABLE reports ADD COLUMN resolved_by UUID REFERENCES users(id);

-- Uma denúncia ABERTA por usuário e item: segura a corrida de dois cliques (vira 409 ALREADY_REPORTED).
CREATE UNIQUE INDEX reports_open_per_reporter_key ON reports (item_id, reporter_id) WHERE status = 'ABERTA';

-- Fila do Admin: por status, mais antigas primeiro.
CREATE INDEX idx_reports_queue ON reports (status, created_at);
