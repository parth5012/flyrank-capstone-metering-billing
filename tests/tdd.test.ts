// P2-T6 TDD hardening (Probe 1+2 edges): reviewer follow-ups from
// P2-T2..T5. No new product logic — test doubles mirror prod semantics
// (UNIQUE + ON CONFLICT DO NOTHING first-write-wins, tenant-scoped lookup,
// cross-tenant conflict -> 409 generic like src/repos/usage.ts).
//
// Red->green note: on P2-T1 stubs (POST /generate 501, GET /usage 400) every
// test below fails (expects 200/409/404-with-shape). On current P2-T2..T5
// wiring they pass. The concurrent strict assert (notEqual) would fail on a
// broken double that returned inserted=true twice; the old tautology
// (`a !== b || count===1`) masked that because count===1 is always true for
// a Map keyed by idempotency_key.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app';
import { setGenerateDeps } from '../src/routes/generate';
import { setUsageDeps } from '../src/routes/usage';
import type { UsageEvent, TokenBreakdown } from '../src/repos/usage';

const FREE_API = 1000;
const FREE_TOKENS = 100_000;
const PRO_API = 100_000;
const PRO_TOKENS = 10_000_000;

function conflictError(): Error & { status: number } {
  // Mirrors src/repos/usage.ts: UNIQUE conflict whose original row is
  // invisible to this tenant -> generic 409, no cross-tenant leak.
  return Object.assign(new Error('idempotency_key conflict'), { status: 409 });
}

// In-memory double: first-write-wins per idempotency_key (mirrors UNIQUE +
// ON CONFLICT DO NOTHING), lookup scoped to tenant_id.
function makeMemoryUsage() {
  const byKey = new Map<string, UsageEvent>();
  async function insert(input: {
    id: string;
    tenantId: string;
    type: 'api_call' | 'ai_token';
    qty: number;
    idempotencyKey: string;
    tokenBreakdown?: TokenBreakdown | null;
  }): Promise<{ event: UsageEvent; inserted: boolean }> {
    const prior = byKey.get(input.idempotencyKey);
    if (prior) {
      if (prior.tenant_id !== input.tenantId) throw conflictError();
      return { event: prior, inserted: false };
    }
    const event: UsageEvent = {
      id: input.id,
      tenant_id: input.tenantId,
      type: input.type,
      qty: input.qty,
      idempotency_key: input.idempotencyKey,
      token_breakdown: input.tokenBreakdown ?? null,
      created_at: new Date().toISOString(),
    };
    byKey.set(input.idempotencyKey, event);
    return { event, inserted: true };
  }
  async function findExisting(tenantId: string, key: string): Promise<UsageEvent | null> {
    const e = byKey.get(key);
    return e && e.tenant_id === tenantId ? e : null;
  }
  async function countApiUsage(tenantId: string): Promise<number> {
    let n = 0;
    for (const e of byKey.values()) if (e.tenant_id === tenantId) n += 1;
    return n;
  }
  async function sumTokenUsage(tenantId: string): Promise<number> {
    let n = 0;
    for (const e of byKey.values()) if (e.tenant_id === tenantId && e.type === 'ai_token') n += e.qty;
    return n;
  }
  function seedApi(tenantId: string, n: number): void {
    for (let i = 0; i < n; i++) {
      const k = `seed-${tenantId}-${i}-${randomUUID()}`;
      byKey.set(k, {
        id: k,
        tenant_id: tenantId,
        type: 'api_call',
        qty: 1,
        idempotency_key: k,
        token_breakdown: null,
        created_at: new Date().toISOString(),
      });
    }
  }
  return { insert, findExisting, countApiUsage, sumTokenUsage, seedApi, byKey };
}

describe('P2-T6 dedup edges (first-write-wins, deduped flag, cross-tenant 409)', () => {
  let server: Server;
  let base = '';
  let mem = makeMemoryUsage();

  before(async () => {
    mem = makeMemoryUsage();
    const findTenant = async (id: string) => {
      if (id !== 'demo-tenant' && id !== 'other-tenant' && id !== 'pro-tenant') return null;
      return {
        id,
        name: id,
        plan: (id === 'pro-tenant' ? 'pro' : 'free') as 'free' | 'pro',
        stripe_customer_id: null,
        status: 'active',
        created_at: '',
      };
    };
    const getPlanLimits = async (planId: string) =>
      planId === 'pro'
        ? { apiLimit: PRO_API, tokenLimit: PRO_TOKENS }
        : { apiLimit: FREE_API, tokenLimit: FREE_TOKENS };
    setGenerateDeps({
      findTenant,
      insert: mem.insert,
      findExisting: mem.findExisting,
      countApiUsage: mem.countApiUsage,
      sumTokenUsage: mem.sumTokenUsage,
      getPlanLimits,
    });
    setUsageDeps({ findTenant, countApiUsage: mem.countApiUsage, sumTokenUsage: mem.sumTokenUsage, getPlanLimits });
    const app = createApp();
    server = app.listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    setGenerateDeps(null);
    setUsageDeps(null);
    server.close();
    await once(server, 'close');
  });

  beforeEach(() => {
    mem.byKey.clear();
  });

  async function post(
    tenant: string,
    key: string,
    body: unknown = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${base}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': tenant, 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  }

  it('deduped false on first write, true on replay, same usage, 1 row', async () => {
    const key = randomUUID();
    const first = await post('demo-tenant', key, { tokens: { input: 10 } });
    const second = await post('demo-tenant', key, { tokens: { input: 10 } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.json.deduped, false);
    assert.equal(second.json.deduped, true);
    assert.deepEqual(second.json.usage, first.json.usage);
    assert.equal(mem.byKey.size, 1);
  });

  it('same key different payload returns original (first-write-wins, no mutation)', async () => {
    const key = randomUUID();
    const first = await post('demo-tenant', key, { tokens: { input: 10 } });
    const second = await post('demo-tenant', key, { tokens: { input: 999 } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.json.deduped, true);
    assert.deepEqual(second.json.usage, first.json.usage, 'conflict returns original stored result');
    const usage = second.json.usage as Record<string, unknown>;
    assert.equal(usage.qty, 10);
    assert.equal(mem.byKey.size, 1);
  });

  it('cross-tenant same key -> 409 generic, no leak, no second row', async () => {
    const key = randomUUID();
    const first = await post('demo-tenant', key, { tokens: { input: 10 } });
    assert.equal(first.status, 200);
    const originalId = (first.json.usage as Record<string, unknown>).id as string;
    const before = mem.byKey.size;

    const replay = await post('other-tenant', key, { tokens: { input: 10 } });
    assert.equal(replay.status, 409, 'cross-tenant key invisible -> 409 like prod repo');
    assert.ok(replay.json.error !== undefined || replay.json.message !== undefined);
    const raw = JSON.stringify(replay.json);
    assert.ok(!raw.includes(originalId), 'must not leak original usage id');
    assert.ok(!raw.includes('demo-tenant'), 'must not leak original tenant id');
    assert.equal(mem.byKey.size, before, 'conflict creates no new event');
    assert.equal(await mem.countApiUsage('other-tenant'), 0);
  });

  it('concurrent same-key POSTs -> 1 row, identical usage, strict deduped split', async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([
      post('demo-tenant', key, { tokens: { input: 7 } }),
      post('demo-tenant', key, { tokens: { input: 7 } }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(a.json.usage, b.json.usage);
    assert.equal(mem.byKey.size, 1);
    // Strict: exactly one false + one true. Old tautology
    // (`!== || count===1`) always passed because count===1 is trivially true
    // for a keyed Map; notEqual forces the real first-write-wins split.
    assert.notEqual(a.json.deduped, b.json.deduped);
  });
});

describe('P2-T6 pro limits + tenant max deferred', () => {
  let server: Server;
  let base = '';
  let mem = makeMemoryUsage();

  before(async () => {
    mem = makeMemoryUsage();
    const findTenant = async (id: string) => {
      if (id !== 'demo-tenant' && id !== 'pro-tenant') return null;
      return {
        id,
        name: id,
        plan: (id === 'pro-tenant' ? 'pro' : 'free') as 'free' | 'pro',
        stripe_customer_id: null,
        status: 'active',
        created_at: '',
      };
    };
    const getPlanLimits = async (planId: string) =>
      planId === 'pro'
        ? { apiLimit: PRO_API, tokenLimit: PRO_TOKENS }
        : { apiLimit: FREE_API, tokenLimit: FREE_TOKENS };
    setGenerateDeps({
      findTenant,
      insert: mem.insert,
      findExisting: mem.findExisting,
      countApiUsage: mem.countApiUsage,
      sumTokenUsage: mem.sumTokenUsage,
      getPlanLimits,
    });
    setUsageDeps({ findTenant, countApiUsage: mem.countApiUsage, sumTokenUsage: mem.sumTokenUsage, getPlanLimits });
    const app = createApp();
    server = app.listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    setGenerateDeps(null);
    setUsageDeps(null);
    server.close();
    await once(server, 'close');
  });

  beforeEach(() => {
    mem.byKey.clear();
  });

  it('Pro GET /usage carries Pro limits (100k API / 10M tokens)', async () => {
    const res = await fetch(`${base}/usage`, { headers: { 'x-tenant-id': 'pro-tenant' } });
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);
    assert.equal(json.plan, 'pro');
    assert.deepEqual(json.api, { used: 0, limit: PRO_API });
    assert.deepEqual(json.tokens, { used: 0, limit: PRO_TOKENS });
  });

  it('Pro writes past Free 1000 still 200 (plan-aware limits, not hardcoded)', async () => {
    mem.seedApi('pro-tenant', 5000); // > Free 1000, << Pro 100k
    const res = await fetch(`${base}/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': 'pro-tenant',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200, 'pro limit 100k allows write at 5001');
    assert.equal(await mem.countApiUsage('pro-tenant'), 5001);
  });

  it('tenant max 128 deferred: overlong id -> 4xx never 500 (no max enforced yet)', async () => {
    // Reviewer asked for tenant max 128. Not implemented (tenantMiddleware is
    // min(1) only, no max) and P2-T6 must not add product logic, so document:
    // overlong tenant passes validation then 404 unknown, never 500.
    const longTenant = `t-${'a'.repeat(200)}`;
    const usageRes = await fetch(`${base}/usage`, { headers: { 'x-tenant-id': longTenant } });
    assert.ok(usageRes.status >= 400 && usageRes.status < 500, `expected 4xx got ${usageRes.status}`);
    assert.notEqual(usageRes.status, 500);
    const genRes = await fetch(`${base}/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': longTenant,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({}),
    });
    assert.ok(genRes.status >= 400 && genRes.status < 500, `expected 4xx got ${genRes.status}`);
    assert.notEqual(genRes.status, 500);
  });
});
