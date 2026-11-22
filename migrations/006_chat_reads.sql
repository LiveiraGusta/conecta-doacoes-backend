-- 006_chat_reads.sql — Mensagens não lidas (V1.1)
-- Até quando cada participante leu cada conversa. Não lida = recebida da outra parte depois de last_read_at.
CREATE TABLE chat_reads (
  item_id      UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id),
  last_read_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (item_id, user_id)
);

-- Contagem de não lidas: mensagens recebidas pelo usuário em cada item.
CREATE INDEX idx_messages_receiver ON chat_messages (receiver_id, item_id, created_at);
