// Scaffold tests: verify structure + pinned constants only. No DB, no Stripe.
// Phase behavior tests (idempotency, quota 999/1000/1001, webhooks) land with their phases.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as pricing from '../src/config/pricing';

const root = path.join(__dirname, '..');
const exists = (p: string): boolean => fs.existsSync(path.join(root, p));

describe('scaffold structure', () => {
  it('routes, services, repos, middleware, jobs stubs exist', () => {
    const files = [
      'src/app.ts',
      'src/server.ts',
      'src/db.ts',
      'src/config/pricing.ts',
      'src/routes/generate.ts',
      'src/routes/usage.ts',
      'src/routes/checkout.ts',
      'src/routes/webhooks.ts',
      'src/services/meter.ts',
      'src/services/quota.ts',
      'src/services/cost.ts',
      'src/services/billing.ts',
      'src/repos/usage.ts',
      'src/repos/tenant.ts',
      'src/repos/stripeEvent.ts',
      'src/middleware/tenant.ts',
      'src/middleware/idempotency.ts',
      'src/middleware/error.ts',
      'src/jobs/reconcile.ts',
      'src/jobs/alerts.ts',
      'db/migrations/001_init.sql',
      'scripts/seed.ts',
      'tsconfig.json',
    ];
    for (const f of files) assert.ok(exists(f), `missing ${f}`);
  });

  it('service stubs declare not_implemented (no phase logic yet)', () => {
    for (const f of ['src/services/meter.ts', 'src/services/quota.ts', 'src/services/cost.ts']) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      assert.match(src, /notImplemented|not_implemented/);
    }
  });
});

describe('pricing constants', () => {
  it('integer cents per 1M, no floats', () => {
    const values: Record<string, unknown> = pricing as unknown as Record<string, unknown>;
    for (const k of ['TOKENS_PER_UNIT', 'INPUT_PER_M_CENTS', 'CACHED_PER_M_CENTS', 'OUTPUT_PER_M_CENTS']) {
      assert.ok(Number.isInteger(values[k]), `${k} must be integer`);
    }
    const raw = fs.readFileSync(path.join(root, 'src/config/pricing.ts'), 'utf8');
    assert.doesNotMatch(raw, /\d+\.\d+/, 'no float literals in pricing');
  });
});

describe('migration', () => {
  it('has idempotency UNIQUE + stripe_events dedup + tenant index', () => {
    const sql = fs.readFileSync(path.join(root, 'db/migrations/001_init.sql'), 'utf8');
    assert.match(sql, /idempotency_key TEXT UNIQUE NOT NULL/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS stripe_events/);
    assert.match(sql, /idx_usage_tenant_created/);
  });
});

describe('manifests', () => {
  it('capstone.yaml has run/seed/test/base_url', () => {
    const y = fs.readFileSync(path.join(root, 'capstone.yaml'), 'utf8');
    for (const k of ['run:', 'seed:', 'test:', 'base_url:']) assert.ok(y.includes(k), `missing ${k}`);
  });

  it('.env.example has stripe + db placeholders', () => {
    const e = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'DATABASE_URL']) {
      assert.ok(e.includes(k), `missing ${k}`);
    }
  });
});
