// P4-T3 background jobs tests (shared req #3): jobs off request path with
// retries + alert log. Nightly reconciliation (DB vs Stripe list, dry-run logs
// mismatches, never auto-mutates) + usage-alerts at 80%/100%.
// In-memory doubles only (no DB, no Stripe network); DI for testability.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runJobWithRetry, type AlertEntry } from '../src/jobs/runner';
import { reconcile } from '../src/jobs/reconcile';
import { checkAlerts } from '../src/jobs/alerts';

function freshLog(): AlertEntry[] {
  return [];
}

describe('reconcile dry-run (P4-T3)', () => {
  it('finds DB-only mismatch (missed webhook), dry-run mutates nothing', async () => {
    const alertLog = freshLog();
    // Dry-run proof: ReconcileDeps exposes ONLY list fns (no insert/upsert),
    // so mutation is impossible by construction. At runtime each list fn must
    // be called exactly once (read-only, one pass each).
    let dbReads = 0;
    let stripeReads = 0;
    const res = await reconcile('demo-tenant', {
      listDbKeys: async () => {
        dbReads += 1;
        return ['evt_a', 'evt_b', 'evt_c'];
      },
      listStripeKeys: async () => {
        stripeReads += 1;
        return ['evt_a', 'evt_b'];
      },
      alertLog,
    });
    assert.deepEqual(res.dbOnly, ['evt_c']);
    assert.deepEqual(res.stripeOnly, []);
    assert.equal(res.mismatchCount, 1);
    assert.equal(res.ok, false);
    assert.equal(dbReads, 1, 'single DB read pass, no writes exist to call');
    assert.equal(stripeReads, 1, 'single Stripe list pass, no writes exist to call');
    assert.ok(
      alertLog.some((e) => e.job === 'reconcile' && e.tenantId === 'demo-tenant'),
      'mismatch must write alert log entry',
    );
  });

  it('finds Stripe-only mismatch too (both directions compared)', async () => {
    const res = await reconcile('demo-tenant', {
      listDbKeys: async () => ['evt_a'],
      listStripeKeys: async () => ['evt_a', 'evt_stripe_only'],
      alertLog: freshLog(),
    });
    assert.deepEqual(res.dbOnly, []);
    assert.deepEqual(res.stripeOnly, ['evt_stripe_only']);
    assert.equal(res.mismatchCount, 1);
    assert.equal(res.ok, false);
  });

  it('clean when lists match (no alert, ok true)', async () => {
    const alertLog = freshLog();
    const res = await reconcile('demo-tenant', {
      listDbKeys: async () => ['evt_a', 'evt_b'],
      listStripeKeys: async () => ['evt_b', 'evt_a'],
      alertLog,
    });
    assert.equal(res.mismatchCount, 0);
    assert.equal(res.ok, true);
    assert.equal(alertLog.length, 0);
  });
});

describe('usage alerts 80%/100% (P4-T3)', () => {
  it('>=80% triggers warn log entry', async () => {
    const alertLog = freshLog();
    const res = await checkAlerts('demo-tenant', {
      // 800/1000 = exactly 80% (Free API limit boundary).
      getUsage: async () => ({ used: 800, limit: 1000 }),
      alertLog,
    });
    assert.equal(res.level, 'warn');
    assert.equal(alertLog.length, 1);
    assert.equal(alertLog[0].level, 'warn');
    assert.equal(alertLog[0].tenantId, 'demo-tenant');
    assert.match(alertLog[0].message, /80/i);
  });

  it('>=100% triggers critical log entry', async () => {
    const alertLog = freshLog();
    const res = await checkAlerts('demo-tenant', {
      getUsage: async () => ({ used: 1000, limit: 1000 }),
      alertLog,
    });
    assert.equal(res.level, 'critical');
    assert.equal(alertLog.length, 1);
    assert.equal(alertLog[0].level, 'critical');
    assert.match(alertLog[0].message, /100|limit|critical/i);
  });

  it('below 80% triggers no log entry', async () => {
    const alertLog = freshLog();
    const res = await checkAlerts('demo-tenant', {
      getUsage: async () => ({ used: 799, limit: 1000 }),
      alertLog,
    });
    assert.equal(res.level, 'ok');
    assert.equal(alertLog.length, 0);
  });
});

describe('runner retry + alert log (P4-T3)', () => {
  it('retry succeeds after transient failures (attempts tracked)', async () => {
    let calls = 0;
    const delays: number[] = [];
    const res = await runJobWithRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('transient boom');
        return 'done';
      },
      {
        jobName: 'reconcile',
        alertLog: freshLog(),
        sleep: async (ms: number) => {
          delays.push(ms);
        },
      },
    );
    assert.equal(res.ok, true);
    assert.equal(res.result, 'done');
    assert.equal(res.attempts, 3);
    assert.equal(calls, 3);
  });

  it('exponential backoff: delays double (base 100 -> 100, 200)', async () => {
    const delays: number[] = [];
    await runJobWithRetry(
      async () => {
        throw new Error('always fails');
      },
      {
        jobName: 'alerts',
        maxRetries: 2,
        baseDelayMs: 100,
        alertLog: freshLog(),
        sleep: async (ms: number) => {
          delays.push(ms);
        },
      },
    );
    assert.deepEqual(delays, [100, 200]);
  });

  it('failure after max retries writes critical alert log', async () => {
    const alertLog = freshLog();
    let calls = 0;
    const res = await runJobWithRetry(
      async () => {
        calls += 1;
        throw new Error('permanent boom');
      },
      { jobName: 'reconcile', maxRetries: 3, alertLog, sleep: async () => {} },
    );
    assert.equal(res.ok, false);
    assert.equal(res.attempts, 4, '1 initial + 3 retries');
    assert.equal(calls, 4);
    assert.ok(res.error instanceof Error);
    const crit = alertLog.filter((e) => e.level === 'critical' && e.job === 'reconcile');
    assert.equal(crit.length, 1, 'exactly one critical alert on final failure');
    assert.match(crit[0].message, /permanent boom|failed|retries/i);
  });
});
