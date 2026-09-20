// stripe_events dedup repo - TODO Phase 3. INSERT ... ON CONFLICT DO NOTHING.
import { notImplemented } from '../services/meter';

export async function markProcessed(): Promise<never> {
  return notImplemented(3);
}
