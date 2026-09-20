// QuotaService.check - TODO Phase 2. Boundary: 1000/1000 allow, 1001 -> 429/402.
import { notImplemented } from './meter';

export async function checkQuota(): Promise<never> {
  return notImplemented(2);
}
