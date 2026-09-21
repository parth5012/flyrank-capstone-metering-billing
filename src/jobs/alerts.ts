// Usage alerts (P4-T3, shared req #3, DESIGN.md §4): warn at >=80% of quota,
// critical at >=100%. Off request path — exported function run by the nightly
// job (wrapped in runJobWithRetry for retries); never blocks /generate.
// Tenant isolation: getUsage is called with tenantId; no cross-tenant reads.
// Integers only (used/limit counts); ratio is for threshold compare, never
// money math (money stays integer cents per DESIGN.md §6).
import { pushAlert, type AlertEntry } from './runner';

/** Warn threshold: 80% of quota. */
export const WARN_RATIO = 0.8;
/** Critical threshold: 100% of quota. */
export const CRIT_RATIO = 1.0;

export interface AlertCheckDeps {
  /** Current usage vs limit for this tenant (API or token quota). */
  getUsage: (tenantId: string) => Promise<{ used: number; limit: number }>;
  /** Alert entries appended here (array log + console via logger). */
  alertLog?: AlertEntry[];
  logger?: (entry: AlertEntry) => void;
}

export type UsageAlertLevel = 'ok' | 'warn' | 'critical';

export interface AlertCheckResult {
  tenantId: string;
  used: number;
  limit: number;
  ratio: number;
  level: UsageAlertLevel;
  alerts: AlertEntry[];
}

/**
 * Check ONE tenant's quota ratio; log warn (>=80%) or critical (>=100%).
 * Below 80% logs nothing. Returns level + shared alert array.
 */
export async function checkAlerts(
  tenantId: string,
  deps: AlertCheckDeps,
): Promise<AlertCheckResult> {
  const { getUsage, alertLog, logger } = deps;
  const alerts: AlertEntry[] = alertLog ?? [];
  const { used, limit } = await getUsage(tenantId);
  // Guard limit <= 0 (no quota configured): any usage is critical, zero is ok.
  const ratio = limit > 0 ? used / limit : used > 0 ? 1 : 0;
  let level: UsageAlertLevel = 'ok';
  if (ratio >= CRIT_RATIO) {
    level = 'critical';
    pushAlert(alerts, logger, {
      level: 'critical',
      job: 'usage-alert',
      tenantId,
      message:
        `usage critical for tenant '${tenantId}': ` +
        `${used}/${limit} (100% of quota reached)`,
    });
  } else if (ratio >= WARN_RATIO) {
    level = 'warn';
    pushAlert(alerts, logger, {
      level: 'warn',
      job: 'usage-alert',
      tenantId,
      message:
        `usage warning for tenant '${tenantId}': ` +
        `${used}/${limit} (80% of quota reached)`,
    });
  }
  return { tenantId, used, limit, ratio, level, alerts };
}
