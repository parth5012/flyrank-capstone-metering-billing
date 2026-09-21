// Nightly reconciliation (P4-T3, shared req #3, DESIGN.md §4): compare DB
// usage-event keys vs Stripe event list and LOG mismatches (missed webhooks).
// Dry-run only: Deps exposes read/list fns, no insert/upsert, so the job
// cannot auto-mutate by construction. Off request path — exported function,
// wired to a scheduler (not a route); wrap in runJobWithRetry for retries.
// Tenant isolation: both list fns are called with tenantId; no cross-tenant
// reads (callers pass per-tenant listers, see src/repos/*).
import { pushAlert, type AlertEntry } from './runner';

export interface ReconcileDeps {
  /** DB keys for this tenant (e.g. idempotency_key / stripe event ids). */
  listDbKeys: (tenantId: string) => Promise<string[]>;
  /** Stripe-side keys for this tenant (test-mode list, never live keys). */
  listStripeKeys: (tenantId: string) => Promise<string[]>;
  /** Alert entries appended here (array log + console via logger). */
  alertLog?: AlertEntry[];
  logger?: (entry: AlertEntry) => void;
}

export interface ReconcileResult {
  tenantId: string;
  /** In DB but missing from Stripe list (e.g. missed webhook / never synced). */
  dbOnly: string[];
  /** In Stripe list but missing from DB (e.g. webhook applied nowhere). */
  stripeOnly: string[];
  mismatchCount: number;
  ok: boolean;
  alerts: AlertEntry[];
}

/**
 * Dry-run reconcile for ONE tenant: diff both lists, log a warn alert on any
 * mismatch, return the diff. Never writes to DB or Stripe.
 */
export async function reconcile(
  tenantId: string,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const { listDbKeys, listStripeKeys, alertLog, logger } = deps;
  const alerts: AlertEntry[] = alertLog ?? [];
  const [dbKeys, stripeKeys] = await Promise.all([
    listDbKeys(tenantId),
    listStripeKeys(tenantId),
  ]);
  const stripeSet = new Set(stripeKeys);
  const dbSet = new Set(dbKeys);
  const dbOnly = dbKeys.filter((k) => !stripeSet.has(k));
  const stripeOnly = stripeKeys.filter((k) => !dbSet.has(k));
  const mismatchCount = dbOnly.length + stripeOnly.length;
  const ok = mismatchCount === 0;
  if (!ok) {
    pushAlert(alerts, logger, {
      level: 'warn',
      job: 'reconcile',
      tenantId,
      message:
        `reconcile mismatch for tenant '${tenantId}': ` +
        `${dbOnly.length} db-only [${dbOnly.join(', ')}], ` +
        `${stripeOnly.length} stripe-only [${stripeOnly.join(', ')}] ` +
        `(dry-run: logged only, no mutation)`,
    });
  }
  return { tenantId, dbOnly, stripeOnly, mismatchCount, ok, alerts };
}
