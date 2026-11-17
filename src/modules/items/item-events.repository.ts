import type { Queryable } from '../../core/db';
import type { EventStatus, ItemEvent } from '../../types';

export interface NewItemEvent {
  itemId: string;
  from: EventStatus | null;
  to: EventStatus;
  actorId: string;
  ngoId?: string | null;
  reason?: string | null;
}

/** Auditoria das transições de items.status. CANCELADO só existe aqui. */
export const itemEventsRepository = {
  async insert(q: Queryable, events: NewItemEvent | NewItemEvent[]): Promise<void> {
    // No máximo 2 eventos por transição: um INSERT cada, em ordem.
    // clock_timestamp() (e não NOW(), que é fixo na transação) mantém a ordem entre eles.
    for (const e of Array.isArray(events) ? events : [events]) {
      await q`
        INSERT INTO item_events (item_id, from_status, to_status, actor_id, ngo_id, reason, created_at)
        VALUES (${e.itemId}, ${e.from}, ${e.to}, ${e.actorId}, ${e.ngoId ?? null}, ${e.reason ?? null}, clock_timestamp())`;
    }
  },

  async listByItem(q: Queryable, itemId: string): Promise<ItemEvent[]> {
    return q<ItemEvent[]>`SELECT * FROM item_events WHERE item_id = ${itemId} ORDER BY created_at, id`;
  },
};

export type ItemEventsRepository = typeof itemEventsRepository;
