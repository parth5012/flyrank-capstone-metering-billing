// stripe_events dedup repo (P2-T1 wiring). UNIQUE(event_id) via PRIMARY KEY
// (see db/migrations/001_init.sql). Webhook verify + sync lands in P2-T5;
// this table makes replays idempotent: INSERT ... ON CONFLICT DO NOTHING.
import { query } from '../db';

// Returns true when this call stored the event, false on replay (already seen).
export async function markProcessed(eventId: string, type: string): Promise<boolean> {
  const { rows } = await query<{ event_id: string }>(
    `INSERT INTO stripe_events (event_id, type) VALUES ($1, $2)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, type],
  );
  return rows.length > 0;
}

export async function isProcessed(eventId: string): Promise<boolean> {
  const { rows } = await query<{ one: string }>(
    'SELECT 1 AS one FROM stripe_events WHERE event_id = $1',
    [eventId],
  );
  return rows.length > 0;
}

export async function removeProcessed(eventId: string): Promise<void> {
  await query('DELETE FROM stripe_events WHERE event_id = $1', [eventId]);
}
