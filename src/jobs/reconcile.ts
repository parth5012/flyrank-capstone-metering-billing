// Nightly reconciliation (DB vs Stripe) - TODO after core ships. Off request path.
import { notImplemented } from '../services/meter';

export async function reconcile(): Promise<never> {
  return notImplemented('stretch');
}
