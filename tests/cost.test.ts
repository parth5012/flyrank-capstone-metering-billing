// P4-T2 Pricing config + CostService.rollup (Probe 5 core).
// TDD red: rollupCost stub throws notImplemented, so all rollup asserts fail
// until src/services/cost.ts lands. Integers only (cents), never FLOAT.
// Formula (src/config/pricing.ts): floor((input*1500 + cached*375 +
// (output+reasoning)*6000) / 1_000_000). Reasoning bills as output.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { rollupCost } from '../src/services/cost';
import type { TokenBreakdown, UsageEvent } from '../src/repos/usage';

const B = (p: Partial<TokenBreakdown>): TokenBreakdown => ({
  input: 0,
  cached_input: 0,
  output: 0,
  reasoning: 0,
  ...p,
});

describe('CostService.rollup (P4-T2)', () => {
  it('cached bills at 1/4 input rate', () => {
    assert.equal(rollupCost([B({ input: 1_000_000 })]), 1500);
    assert.equal(rollupCost([B({ cached_input: 1_000_000 })]), 375);
    assert.equal(375 * 4, 1500);
  });

  it('reasoning bills as output', () => {
    assert.equal(rollupCost([B({ output: 1_000_000 })]), 6000);
    assert.equal(rollupCost([B({ reasoning: 1_000_000 })]), 6000);
    assert.equal(
      rollupCost([B({ output: 500_000, reasoning: 500_000 })]),
      6000,
      'output+reasoning share OUTPUT rate',
    );
  });

  it('mixed breakdown pins deterministic cents total', () => {
    // 100k*1500=150M + 200k*375=75M + 80k*6000=480M = 705M / 1M = 705c.
    const total = rollupCost([
      B({ input: 100_000, cached_input: 200_000, output: 50_000, reasoning: 30_000 }),
    ]);
    assert.equal(total, 705);
    assert.ok(Number.isInteger(total), 'integers only');
  });

  it('never sums raw tokens (cached-heavy regression)', () => {
    // Pure cached 1M: correct 375c. Blended-rate bugs: input rate -> 1500c
    // (4x overbill), output rate -> 6000c (16x overbill).
    const cachedOnly = rollupCost([B({ cached_input: 1_000_000 })]);
    assert.equal(cachedOnly, 375);
    assert.notEqual(cachedOnly, 1500);
    assert.notEqual(cachedOnly, 6000);
    // Split 1M cached + 1M output: correct 375+6000=6375c. Blended at input
    // rate (2M*1500/1M=3000) under-bills; blended at output rate
    // (2M*6000/1M=12000) over-bills. Per-category sums only.
    const split = rollupCost([B({ cached_input: 1_000_000, output: 1_000_000 })]);
    assert.equal(split, 6375);
    assert.notEqual(split, 3000);
    assert.notEqual(split, 12000);
  });

  it('tiny events accrue via sum-then-floor (per-event floor would lose)', () => {
    // Single 100-input event: floor(100*1500/1M)=floor(0.15)=0c.
    assert.equal(rollupCost([B({ input: 100 })]), 0);
    // 10x100-input = 1000 input: floor(1000*1500/1M)=floor(1.5)=1c.
    // Per-event floor would sum 10x0=0c (lost cent).
    const ten = Array.from({ length: 10 }, () => B({ input: 100 }));
    assert.equal(rollupCost(ten), 1);
  });

  it('1c thresholds: ~667 input / ~2667 cached / ~167 output', () => {
    assert.equal(rollupCost([B({ input: 666 })]), 0);
    assert.equal(rollupCost([B({ input: 667 })]), 1);
    assert.equal(rollupCost([B({ cached_input: 2666 })]), 0);
    assert.equal(rollupCost([B({ cached_input: 2667 })]), 1);
    assert.equal(rollupCost([B({ output: 166 })]), 0);
    assert.equal(rollupCost([B({ output: 167 })]), 1);
    assert.equal(rollupCost([B({ reasoning: 167 })]), 1);
  });

  it('empty / zero -> 0, integers only', () => {
    assert.equal(rollupCost([]), 0);
    assert.equal(rollupCost([B({})]), 0);
    const v = rollupCost([B({ input: 1, cached_input: 2, output: 3, reasoning: 4 })]);
    assert.ok(Number.isInteger(v));
  });

  it('large volumes stay integer-safe (P4-T4)', () => {
    // 1B input: floor(1e9*1500/1e6) = 1_500_000c. Numerator 1.5e12,
    // far below Number.MAX_SAFE_INTEGER (2^53 ~= 9e15) — no FLOAT drift.
    assert.equal(rollupCost([B({ input: 1_000_000_000 })]), 1_500_000);
    // 10M per category: 15000 + 3750 + 120000 = 138750c.
    const mixed = rollupCost([
      B({ input: 10_000_000, cached_input: 10_000_000, output: 10_000_000, reasoning: 10_000_000 }),
    ]);
    assert.equal(mixed, 138_750);
    assert.ok(Number.isInteger(mixed));
    assert.ok(mixed < Number.MAX_SAFE_INTEGER);
  });

  it('period rollup sums each event once, no double-count (P4-T4)', () => {
    // Two identical 1M-input events -> 2x single (3000c, not 1500 or 6000).
    const single = B({ input: 1_000_000 });
    assert.equal(rollupCost([single, single]), 3000);
    assert.equal(rollupCost([single, single]), 2 * rollupCost([single]));
    // Additive across a period: split events equal one combined breakdown.
    const a = B({ input: 100_000, cached_input: 200_000 });
    const b = B({ output: 50_000, reasoning: 30_000 });
    const combined = B({ input: 100_000, cached_input: 200_000, output: 50_000, reasoning: 30_000 });
    assert.equal(rollupCost([a, b]), rollupCost([combined]));
    assert.equal(rollupCost([a, b]), 705);
  });
});

// GET /usage cost_cents matches rollup (same constants, tenant-isolated).
describe('GET /usage cost_cents matches rollup (P4-T2)', () => {
  function makeMemoryUsage() {
    const byKey = new Map<string, UsageEvent>();
    async function insert(input: {
      id: string; tenantId: string; type: 'api_call' | 'ai_token'; qty: number;
      idempotencyKey: string; tokenBreakdown?: TokenBreakdown | null;
    }): Promise<{ event: UsageEvent; inserted: boolean }> {
      const prior = byKey.get(input.idempotencyKey);
      if (prior) {
        if (prior.tenant_id !== input.tenantId) throw new Error('cross-tenant key invisible');
        return { event: prior, inserted: false };
      }
      const event: UsageEvent = {
        id: input.id, tenant_id: input.tenantId, type: input.type, qty: input.qty,
        idempotency_key: input.idempotencyKey, token_breakdown: input.tokenBreakdown ?? null,
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
    async function sumTokenBreakdowns(tenantId: string): Promise<TokenBreakdown> {
      const total: TokenBreakdown = { input: 0, cached_input: 0, output: 0, reasoning: 0 };
      for (const e of byKey.values()) {
        if (e.tenant_id !== tenantId || e.type !== 'ai_token' || !e.token_breakdown) continue;
        total.input += e.token_breakdown.input;
        total.cached_input += e.token_breakdown.cached_input;
        total.output += e.token_breakdown.output;
        total.reasoning += e.token_breakdown.reasoning;
      }
      return total;
    }
    return { insert, findExisting, countApiUsage, sumTokenUsage, sumTokenBreakdowns, byKey };
  }

  let server: Server;
  let base = '';
  let mem = makeMemoryUsage();

  before(async () => {
    // Lazy-require routers here so the red run (stub cost.ts) still loads:
    // usage route imports rollupCost at module top.
    const { setGenerateDeps } = await import('../src/routes/generate');
    const { setUsageDeps } = await import('../src/routes/usage');
    const { createApp } = await import('../src/app');
    mem = makeMemoryUsage();
    const findTenant = async (id: string) => {
      if (id !== 'demo-tenant' && id !== 'other-tenant') return null;
      return {
        id, name: id, plan: 'free' as const, stripe_customer_id: null,
        status: 'active', created_at: '',
      };
    };
    // Roomy limits so the 380k-token mixed write passes quota.
    const getPlanLimits = async () => ({ apiLimit: 100_000, tokenLimit: 10_000_000 });
    setGenerateDeps({
      findTenant, insert: mem.insert, findExisting: mem.findExisting,
      countApiUsage: mem.countApiUsage, sumTokenUsage: mem.sumTokenUsage,
      getPlanLimits,
    });
    setUsageDeps({
      findTenant, countApiUsage: mem.countApiUsage, sumTokenUsage: mem.sumTokenUsage,
      sumTokenBreakdowns: mem.sumTokenBreakdowns, getPlanLimits,
    } as never);
    const app = createApp();
    server = app.listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    const { setGenerateDeps } = await import('../src/routes/generate');
    const { setUsageDeps } = await import('../src/routes/usage');
    setGenerateDeps(null);
    setUsageDeps(null);
    server.close();
    await once(server, 'close');
  });

  beforeEach(() => {
    mem.byKey.clear();
  });

  it('mixed write -> GET /usage cost_cents 705 matches rollup', async () => {
    const post = await fetch(`${base}/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': 'demo-tenant',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        tokens: { input: 100_000, cached_input: 200_000, output: 50_000, reasoning: 30_000 },
      }),
    });
    assert.equal(post.status, 200);
    const res = await fetch(`${base}/usage`, { headers: { 'x-tenant-id': 'demo-tenant' } });
    assert.equal(res.status, 200);
    const json = (await res.json()) as Record<string, unknown>;
    const expected = rollupCost([
      B({ input: 100_000, cached_input: 200_000, output: 50_000, reasoning: 30_000 }),
    ]);
    assert.equal(expected, 705);
    assert.equal(json.cost_cents, 705);
    assert.equal(json.cost_cents, expected);
    assert.ok(Number.isInteger(json.cost_cents as number));
    assert.deepEqual(json.tokens, { used: 380_000, limit: 10_000_000 });
  });

  it('tenant isolation: cost scoped per tenant', async () => {
    for (const body of [{ tokens: { input: 1_000_000 } }]) {
      const r = await fetch(`${base}/generate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': 'demo-tenant',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 200);
    }
    const demo = (await (
      await fetch(`${base}/usage`, { headers: { 'x-tenant-id': 'demo-tenant' } })
    ).json()) as Record<string, unknown>;
    const other = (await (
      await fetch(`${base}/usage`, { headers: { 'x-tenant-id': 'other-tenant' } })
    ).json()) as Record<string, unknown>;
    assert.equal(demo.cost_cents, 1500);
    assert.equal(other.cost_cents, 0);
  });

  it('GET /usage reads are stable: repeated fetch same cost (P4-T4)', async () => {
    const post = await fetch(`${base}/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': 'demo-tenant',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        tokens: { input: 100_000, cached_input: 200_000, output: 50_000, reasoning: 30_000 },
      }),
    });
    assert.equal(post.status, 200);
    const first = (await (
      await fetch(`${base}/usage`, { headers: { 'x-tenant-id': 'demo-tenant' } })
    ).json()) as Record<string, unknown>;
    const second = (await (
      await fetch(`${base}/usage`, { headers: { 'x-tenant-id': 'demo-tenant' } })
    ).json()) as Record<string, unknown>;
    // Read path accrues nothing: same 705c twice, same token usage.
    assert.equal(first.cost_cents, 705);
    assert.equal(second.cost_cents, 705);
    assert.deepEqual(first.tokens, second.tokens);
  });
});
