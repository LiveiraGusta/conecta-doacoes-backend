import type { Queryable } from '../../core/db';
import type { ChatMessage, ChatSummary, Counterpart, Page } from '../../types';

export const chatsRepository = {
  /**
   * Conversas do usuário: itens EM_PROGRESSO e DOADO em que ele é o doador ou a ONG selecionada.
   * Ordem: atividade mais recente (última mensagem do par atual ou última transição do item).
   */
  async listForUser(
    q: Queryable,
    f: { userId: string; status?: 'EM_PROGRESSO' | 'DOADO'; limit: number; offset: number },
  ): Promise<Page<ChatSummary>> {
    const where = q`
      i.status IN ('EM_PROGRESSO', 'DOADO')
      AND (i.donor_id = ${f.userId} OR i.selected_ngo_id = ${f.userId})
      ${f.status ? q`AND i.status = ${f.status}` : q``}`;

    const [count] = await q<{ total: number }[]>`SELECT count(*)::int AS total FROM items i WHERE ${where}`;
    const rows = await q<ChatSummary[]>`
      SELECT i.id AS item_id, i.title AS item_title, i.status AS item_status,
             (SELECT p.photo_url FROM item_photos p WHERE p.item_id = i.id ORDER BY p.created_at, p.id LIMIT 1) AS item_photo,
             cp.id AS counterpart_id, cp.name AS counterpart_name, cp.role AS counterpart_role,
             lm.message AS last_message, lm.sender_id AS last_sender_id, lm.created_at AS last_created_at
      FROM items i
      JOIN users cp ON cp.id = CASE WHEN i.donor_id = ${f.userId} THEN i.selected_ngo_id ELSE i.donor_id END
      LEFT JOIN LATERAL (
        SELECT c.message, c.sender_id, c.created_at
        FROM chat_messages c
        WHERE c.item_id = i.id
          AND c.sender_id IN (i.donor_id, i.selected_ngo_id) AND c.receiver_id IN (i.donor_id, i.selected_ngo_id)
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT 1
      ) lm ON true
      LEFT JOIN LATERAL (SELECT max(e.created_at) AS at FROM item_events e WHERE e.item_id = i.id) ev ON true
      WHERE ${where}
      ORDER BY GREATEST(lm.created_at, ev.at, i.created_at) DESC, i.id
      LIMIT ${f.limit} OFFSET ${f.offset}`;
    return { total: count?.total ?? 0, rows };
  },

  /**
   * Mensagens da negociação atual: só as trocadas entre o doador e a ONG selecionada.
   * Assim, depois de um cancelamento, a nova ONG não lê a conversa anterior.
   */
  async listPairMessages(
    q: Queryable,
    f: { itemId: string; donorId: string; ngoId: string; after?: Date },
  ): Promise<ChatMessage[]> {
    return q<ChatMessage[]>`
      SELECT * FROM chat_messages
      WHERE item_id = ${f.itemId}
        AND sender_id IN (${f.donorId}, ${f.ngoId}) AND receiver_id IN (${f.donorId}, ${f.ngoId})
        ${f.after ? q`AND created_at > ${f.after}` : q``}
      ORDER BY created_at ASC, id ASC`;
  },

  /**
   * Grava a mensagem só se o item está EM_PROGRESSO e o remetente é parte da negociação.
   * O destinatário é a outra parte. Atômico contra um cancelamento simultâneo.
   */
  async insertIfOpen(q: Queryable, f: { itemId: string; senderId: string; message: string }): Promise<ChatMessage | null> {
    const [row] = await q<ChatMessage[]>`
      INSERT INTO chat_messages (item_id, sender_id, receiver_id, message, created_at)
      SELECT i.id, ${f.senderId},
             CASE WHEN i.donor_id = ${f.senderId} THEN i.selected_ngo_id ELSE i.donor_id END,
             -- Precisão de milissegundos, a mesma do ISO que o cliente devolve em ?after=.
             ${f.message}, date_trunc('milliseconds', clock_timestamp())
      FROM items i
      WHERE i.id = ${f.itemId} AND i.status = 'EM_PROGRESSO'
        AND ${f.senderId} IN (i.donor_id, i.selected_ngo_id)
      RETURNING *`;
    return row ?? null;
  },

  async findCounterpart(q: Queryable, userId: string): Promise<Counterpart | null> {
    const [row] = await q<Counterpart[]>`SELECT id, name, role FROM users WHERE id = ${userId}`;
    return row ?? null;
  },
};

export type ChatsRepository = typeof chatsRepository;
