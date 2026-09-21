// P2-T5 GET /usage rollup tests: tenant-isolated read of usage_events.
// Shape (DESIGN.md §3): {tenant,plan,api:{used,limit},tokens:{used,limit},
// cost_cents,period}. cost_cents placeholder 0 until P4. In-memory doubles
// (no Docker DB); live-DB curl proof deferred to P2-T7.
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

// Shared in-memory store for /generate writes + /usage reads (mirrors
// UNIQUE + ON CONFLICT DO NOTHING first-write-wins, per-tenant counts).
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
  return { insert, findExisting, countApiUsage, sumTokenUsage, byKey };
}

describe('GET /usage rollup (P2-T5)', () => {
  let server: Server;
  let base = '';
  let mem = makeMemoryUsage();

  before(async () => {
    mem = makeMemoryUsage();
    const findTenant = async (id: string) => {
      if (id !== 'demo-tenant' && id !== 'other-tenant') return null;
      return {
        id, name: id, plan: 'free' as const, stripe_customer_id: null,
        status: 'active', created_at: '',
      };
    };
    const getPlanLimits = async () => ({ apiLimit: FREE_API, tokenLimit: FREE_TOKENS });
    setGenerateDeps({
      findTenant, insert: mem.insert, findExisting: mem.findExisting,
      countApiUsage: mem.countApiUsage, sumTokenUsage: mem.sumTokenUsage,
      getPlanLimits,
    });
    setUsageDeps({
      findTenant, countApiUsage: mem.countApiUsage, sumTokenUsage: mem.sumTokenUsage,
      getPlanLimits,
    });
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

  async function getUsage(tenant?: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const headers: Record<string, string> = {};
    if (tenant !== undefined) headers['x-tenant-id'] = tenant;
    const res = await fetch(`${base}/usage`, { headers });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  }

  async function postGenerate(tenant: string, body: unknown = {}): Promise<number> {
    const res = await fetch(`${base}/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenant,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    return res.status;
  }

  it('empty tenant -> zeros with Free limits, stable shape, cost_cents 0 placeholder', async () => {
    const { status, json } = await getUsage('demo-tenant');
    assert.equal(status, 200);
    assert.equal(json.tenant, 'demo-tenant');
    assert.equal(json.plan, 'free');
    assert.deepEqual(json.api, { used: 0, limit: FREE_API });
    assert.deepEqual(json.tokens, { used: 0, limit: FREE_TOKENS });
    assert.equal(json.cost_cents, 0);
    assert.ok(Number.isInteger(json.cost_cents as number), 'integers only');
    const period = json.period as Record<string, unknown>;
    assert.ok(typeof period.start === 'string' && typeof period.end === 'string');
    assert.ok(Date.parse(period.start as string) < Date.parse(period.end as string));
  });

  it('rollup after writes: api count + token sum via POST /generate', async () => {
    await postGenerate('demo-tenant', {});
    await postGenerate('demo-tenant', {});
    await postGenerate('demo-tenant', { tokens: { input: 10, output: 5 } });
    const { status, json } = await getUsage('demo-tenant');
    assert.equal(status, 200);
    assert.deepEqual(json.api, { used: 3, limit: FREE_API });
    assert.deepEqual(json.tokens, { used: 15, limit: FREE_TOKENS });
  });

  it('tenant isolation: other tenant sees only its own usage', async () => {
    await postGenerate('demo-tenant', {});
    await postGenerate('demo-tenant', { tokens: { input: 100 } });
    await postGenerate('other-tenant', {});
    const demo = await getUsage('demo-tenant');
    const other = await getUsage('other-tenant');
    assert.deepEqual(demo.json.api, { used: 2, limit: FREE_API });
    assert.deepEqual(demo.json.tokens, { used: 100, limit: FREE_TOKENS });
    assert.deepEqual(other.json.api, { used: 1, limit: FREE_API });
    assert.deepEqual(other.json.tokens, { used: 0, limit: FREE_TOKENS });
  });

  it('unknown tenant -> 4xx', async () => {
    const { status, json } = await getUsage('nope-tenant');
    assert.equal(status, 404);
    assert.equal(json.error, 'unknown_tenant');
  });

  it('missing X-Tenant-Id -> 400, never 500', async () => {
    const { status } = await getUsage(undefined);
    assert.equal(status, 400);
    assert.notEqual(status, 500);
  });
});
