// Scaffold tests: verify structure + pinned constants only. No DB, no Stripe.
// Phase behavior tests (idempotency, quota 999/1000/1001, webhooks) land with their phases.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import * as pricing from '../src/config/pricing';
import { createApp } from '../src/app';

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

describe('scaffold wiring (P2-T1)', () => {
  it('db.ts pools DATABASE_URL + runs migrations from db/migrations', () => {
    const src = fs.readFileSync(path.join(root, 'src/db.ts'), 'utf8');
    assert.match(src, /process\.env\.DATABASE_URL/);
    assert.match(src, /new Pool/);
    assert.match(src, /runMigrations/);
    assert.match(src, /db.*migrations/);
    assert.ok(exists('db/migrations/001_init.sql'));
  });

  it('repos filter tenant_id + use ON CONFLICT DO NOTHING', () => {
    const usage = fs.readFileSync(path.join(root, 'src/repos/usage.ts'), 'utf8');
    assert.match(usage, /tenant_id/);
    assert.match(usage, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
    const tenant = fs.readFileSync(path.join(root, 'src/repos/tenant.ts'), 'utf8');
    assert.match(tenant, /WHERE id = \$1/);
    assert.match(tenant, /ON CONFLICT \(id\) DO/);
    const stripe = fs.readFileSync(path.join(root, 'src/repos/stripeEvent.ts'), 'utf8');
    assert.match(stripe, /ON CONFLICT \(event_id\) DO NOTHING/);
  });

  it('tenant isolation: idempotency lookup scopes to tenant_id', () => {
    const usage = fs.readFileSync(path.join(root, 'src/repos/usage.ts'), 'utf8');
    assert.match(usage, /WHERE tenant_id = \$1 AND idempotency_key = \$2/);
  });

  it('seed.ts upserts Free/Pro + demo-tenant idempotently', () => {
    const seed = fs.readFileSync(path.join(root, 'scripts/seed.ts'), 'utf8');
    for (const token of ['1000', '100000', '10000000', '2000', 'demo-tenant', 'ON CONFLICT']) {
      assert.ok(seed.includes(token), `seed missing ${token}`);
    }
  });

  it('app mounts routers + error middleware (no phase logic)', () => {
    const src = fs.readFileSync(path.join(root, 'src/app.ts'), 'utf8');
    for (const r of ['/generate', '/usage', '/checkout', '/webhooks/stripe']) {
      assert.ok(src.includes(`'${r}'`), `app missing router ${r}`);
    }
    assert.ok(src.includes('errorMiddleware'), 'app missing error middleware');
    assert.ok(src.includes('express.raw'), 'webhooks must keep raw body');
  });

  it('live smoke: /health 200, phase stubs 501, unknown route 404 (no DB)', async () => {
    const app = createApp();
    const server = app.listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });

      const post = (p: string): Promise<number> =>
        fetch(`${base}${p}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }).then((r) => r.status);
      assert.equal(await post('/generate'), 400); // P2-T2: missing headers -> 400 (valid -> 501, see validation.test.ts)
      assert.equal(await post('/checkout'), 400); // P3-T2: implemented, missing tenant_id -> 400
      assert.equal(await post('/webhooks/stripe'), 501);
      assert.equal((await fetch(`${base}/usage`)).status, 400); // P2-T5: implemented, missing tenant header -> 400
      assert.equal((await fetch(`${base}/nope`)).status, 404);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
