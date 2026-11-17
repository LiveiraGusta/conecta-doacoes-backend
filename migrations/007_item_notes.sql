-- 007_item_notes.sql — Observações do doador (integração com o frontend, fase 0.2)
-- Texto livre e opcional, separado da descrição: retirada, estado de conservação, horários etc.
-- Aparece no detalhe do item (logado), não no card do feed.
ALTER TABLE items
  ADD COLUMN notes TEXT NULL,
  ADD CONSTRAINT items_notes_length CHECK (notes IS NULL OR char_length(notes) <= 1000);
