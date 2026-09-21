// Job runner (P4-T3, shared req #3): background jobs run OFF the request
// path (no route wiring; exported functions only) with exponential-backoff
// retries + alert log. Alert log = caller-owned array (returned for tests) +
// console output (default logger) — pass a file-writing logger in prod.
// DI for testability: inject sleep/logger/alertLog, never hardcode timers.
export type AlertLevel = 'info' | 'warn' | 'critical';

export interface AlertEntry {
  level: AlertLevel;
  job: string;
  message: string;
  tenantId?: string;
  attempt?: number;
  at: string;
}

export interface RunJobOptions {
  jobName: string;
  /** Retries AFTER the initial attempt. Default 3 (1 initial + 3 = 4 total). */
  maxRetries?: number;
  /** Base delay ms; retry i waits base * 2^i. Default 100. */
  baseDelayMs?: number;
  /** Alert entries appended here AND returned in result (for tests). */
  alertLog?: AlertEntry[];
  /** Injectable timer (tests record delays, skip waiting). */
  sleep?: (ms: number) => Promise<void>;
  /** Console by default; pass file writer in prod. */
  logger?: (entry: AlertEntry) => void;
}

export interface JobResult<T> {
  ok: boolean;
  attempts: number;
  result?: T;
  error?: unknown;
  alerts: AlertEntry[];
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const defaultLogger = (entry: AlertEntry): void => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify(entry));
};

/** Append to alert log + console logger; returns the entry. */
export function pushAlert(
  alertLog: AlertEntry[] | undefined,
  logger: ((entry: AlertEntry) => void) | undefined,
  base: Omit<AlertEntry, 'at'>,
): AlertEntry {
  const entry: AlertEntry = { ...base, at: new Date().toISOString() };
  alertLog?.push(entry);
  (logger ?? defaultLogger)(entry);
  return entry;
}

/**
 * Run fn off-request-path with retries. Success returns { ok: true } with no
 * alert. Final failure appends exactly ONE critical alert (job name, attempts,
 * error message) and returns { ok: false } — caller decides next action.
 */
export async function runJobWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RunJobOptions,
): Promise<JobResult<T>> {
  const {
    jobName,
    maxRetries = 3,
    baseDelayMs = 100,
    alertLog,
    sleep = defaultSleep,
    logger,
  } = opts;
  const alerts: AlertEntry[] = alertLog ?? [];
  let attempt = 0;
  // attempt counts total tries; retriesLeft counts remaining retries.
  for (let retriesLeft = maxRetries; ; retriesLeft -= 1) {
    attempt += 1;
    try {
      const result = await fn(attempt);
      return { ok: true, attempts: attempt, result, alerts };
    } catch (error) {
      if (retriesLeft <= 0) {
        const message =
          `job '${jobName}' failed after ${attempt} attempt(s): ` +
          (error instanceof Error ? error.message : String(error));
        pushAlert(alerts, logger, {
          level: 'critical',
          job: jobName,
          message,
          attempt,
        });
        return { ok: false, attempts: attempt, error, alerts };
      }
      // Exponential backoff: retry #1 waits base*2^0, #2 base*2^1, ...
      const retryIndex = maxRetries - retriesLeft;
      await sleep(baseDelayMs * 2 ** retryIndex);
    }
  }
}
