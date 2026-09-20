// P2-T4 quota tests (Probe 2 core): QuotaService.check boundary + 429/402.
// Rule: current + requested > limit checked BEFORE write. Free 1000 API /
// 100k tokens, Pro 100k API / 10M tokens. 999 allow, 1000 allow (last
// allowed), 1001 -> 429 quota_exceeded (+Retry-After) or 402
// upgrade_required. Over-limit writes create no event. Tenant-isolated.
// In-memory doubles (no Docker DB); live-DB proof deferred to P2-T7.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app';
import { evaluateQuota, checkQuota, RETRY_AFTER_SECONDS } from '../src/services/quota';
import { setGenerateDeps } from '../src/routes/generate';
import type { UsageEvent, TokenBreakdown } from '../src/repos/usage';

const FREE_API = 1000;
const FREE_TOKENS = 100_000;

function mustDeny(d: ReturnType<typeof evaluateQuota>): Extract<ReturnType<typeof evaluateQuota>, { allowed: false }> {
  if (d.allowed) throw new Error('expected deny, got allow');
  return d;
}

describe('QuotaService boundary (P2-T4 unit)', () => {
  it('API 999 allow / 1000 allow (last) / 1001 deny (Free 1000)', () => {
    const base = { tokenUsed: 0, tokenLimit: FREE_TOKENS, apiLimit: FREE_API, plan: 'free' as const, status: 'active', requestedTokens: 0 };
    assert.equal(evaluateQuota({ ...base, apiUsed: 998, requestedApi: 1 }).allowed, true); // total 999
    assert.equal(evaluateQuota({ ...base, apiUsed: 999, requestedApi: 1 }).allowed, true); // total 1000 last allowed
    const denied = mustDeny(evaluateQuota({ ...base, apiUsed: 1000, requestedApi: 1 }));
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, 429);
    assert.equal(denied.reason, 'quota_exceeded');
  });

  it('token quota same pattern (Free 100k)', () => {
    const base = { apiUsed: 0, apiLimit: FREE_API, tokenLimit: FREE_TOKENS, plan: 'free' as const, status: 'active', requestedApi: 1 };
    assert.equal(evaluateQuota({ ...base, tokenUsed: 99_998, requestedTokens: 1 }).allowed, true); // total 99999
    assert.equal(evaluateQuota({ ...base, tokenUsed: 99_999, requestedTokens: 1 }).allowed, true); // total 100000 last allowed
    const denied = mustDeny(evaluateQuota({ ...base, tokenUsed: 100_000, requestedTokens: 1 }));
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, 429);
  });

  it('multi-token request exceeding limit denies (99999 + 2 > 100000)', () => {
    const denied = mustDeny(evaluateQuota({
      apiUsed: 0, apiLimit: FREE_API, tokenUsed: 99_999, tokenLimit: FREE_TOKENS,
      plan: 'free', status: 'active', requestedApi: 1, requestedTokens: 2,
    }));
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, 429);
  });

  it('429 carries retry_after + Retry-After value documented (60)', () => {
    assert.equal(RETRY_AFTER_SECONDS, 60);
    const denied = mustDeny(evaluateQuota({
      apiUsed: FREE_API, apiLimit: FREE_API, tokenUsed: 0, tokenLimit: FREE_TOKENS,
      plan: 'free', status: 'active', requestedApi: 1, requestedTokens: 0,
    }));
    assert.equal(denied.code, 429);
    assert.equal(denied.retryAfter, 60);
    assert.match(denied.message, /retry|limit|quota/i);
  });

  it('402 for lapsed/unpaid status explains upgrade', () => {
    for (const status of ['past_due', 'unpaid', 'lapsed', 'canceled']) {
      const denied = mustDeny(evaluateQuota({
        apiUsed: 0, apiLimit: FREE_API, tokenUsed: 0, tokenLimit: FREE_TOKENS,
        plan: 'free', status, requestedApi: 1, requestedTokens: 0,
      }));
      assert.equal(denied.allowed, false);
      assert.equal(denied.code, 402);
      assert.equal(denied.reason, 'upgrade_required');
      assert.match(denied.message, /upgrade|payment|billing|subscription/i);
    }
  });

  it('Pro limits from plans (100k API / 10M tokens)', async () => {
    const ok = await checkQuota(
      { tenantId: 't', plan: 'pro', status: 'active', requestedApi: 1, requestedTokens: 1 },
      {
        getLimits: async () => ({ apiLimit: 100_000, tokenLimit: 10_000_000 }),
        getUsage: async () => ({ apiUsed: 99_999, tokenUsed: 9_999_999 }),
      },
    );
    assert.equal(ok.allowed, true);
    const denied = mustDeny(await checkQuota(
      { tenantId: 't', plan: 'pro', status: 'active', requestedApi: 1, requestedTokens: 0 },
      {
        getLimits: async () => ({ apiLimit: 100_000, tokenLimit: 10_000_000 }),
        getUsage: async () => ({ apiUsed: 100_000, tokenUsed: 0 }),
      },
    ));
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, 429);
  });
});

// In-memory usage store: first-write-wins per idempotency_key (mirrors
// UNIQUE + ON CONFLICT DO NOTHING), counts scoped per tenant.
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
  // Seed N api_call rows directly (bypasses HTTP, no quota).
  function seedApi(tenantId: string, n: number): void {
    for (let i = 0; i < n; i++) {
      const k = `seed-${tenantId}-${i}-${randomUUID()}`;
      byKey.set(k, {
        id: k, tenant_id: tenantId, type: 'api_call', qty: 1, idempotency_key: k,
        token_breakdown: null, created_at: new Date().toISOString(),
      });
    }
  }
  function seedTokens(tenantId: string, qty: number): void {
    const k = `seed-tok-${tenantId}-${randomUUID()}`;
    byKey.set(k, {
      id: k, tenant_id: tenantId, type: 'ai_token', qty, idempotency_key: k,
      token_breakdown: { input: qty, cached_input: 0, output: 0, reasoning: 0 },
      created_at: new Date().toISOString(),
    });
  }
  return { insert, findExisting, countApiUsage, sumTokenUsage, seedApi, seedTokens, byKey };
}

describe('POST /generate quota gate (P2-T4, HTTP)', () => {
  let server: Server;
  let base = '';
  let mem = makeMemoryUsage();
  let statuses = new Map<string, string>();

  before(async () => {
    mem = makeMemoryUsage();
    statuses = new Map([['demo-tenant', 'active']]);
    setGenerateDeps({
      findTenant: async (id: string) => {
        if (id !== 'demo-tenant' && id !== 'other-tenant') return null;
        return {
          id, name: id, plan: 'free' as const, stripe_customer_id: null,
          status: statuses.get(id) ?? 'active', created_at: '',
        };
      },
      insert: mem.insert,
      findExisting: mem.findExisting,
      countApiUsage: mem.countApiUsage,
      sumTokenUsage: mem.sumTokenUsage,
      getPlanLimits: async () => ({ apiLimit: FREE_API, tokenLimit: FREE_TOKENS }),
    });
    const app = createApp();
    server = app.listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    setGenerateDeps(null);
    server.close();
    await once(server, 'close');
  });

  beforeEach(() => {
    mem.byKey.clear();
    statuses.set('demo-tenant', 'active');
    statuses.set('other-tenant', 'active');
  });

  async function post(tenant: string, key: string, body: unknown = {}): Promise<{ status: number; headers: Headers; json: Record<string, unknown> }> {
    const res = await fetch(`${base}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': tenant, 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, headers: res.headers, json };
  }

  it('999 -> 1000 allows (last allowed), count becomes 1000', async () => {
    mem.seedApi('demo-tenant', 999);
    const r = await post('demo-tenant', randomUUID(), {});
    assert.equal(r.status, 200);
    assert.equal(r.json.allowed, true);
    assert.equal(await mem.countApiUsage('demo-tenant'), 1000);
  });

  it('1001st -> 429 quota_exceeded + Retry-After, no new event', async () => {
    mem.seedApi('demo-tenant', 1000);
    const before = await mem.countApiUsage('demo-tenant');
    const r = await post('demo-tenant', randomUUID(), {});
    assert.equal(r.status, 429);
    assert.equal(r.json.reason, 'quota_exceeded');
    assert.ok(typeof r.json.message === 'string' && r.json.message.length > 0);
    assert.equal(r.json.retry_after, 60);
    assert.equal(r.headers.get('retry-after'), '60');
    assert.equal(await mem.countApiUsage('demo-tenant'), before, 'over-limit creates no event');
  });

  it('token boundary: 100000 allows, 100001 -> 429 with no event', async () => {
    mem.seedTokens('demo-tenant', 99_999);
    const ok = await post('demo-tenant', randomUUID(), { tokens: { input: 1 } });
    assert.equal(ok.status, 200, '99999 + 1 = 100000 last allowed');
    const before = mem.byKey.size;
    const denied = await post('demo-tenant', randomUUID(), { tokens: { input: 1 } });
    assert.equal(denied.status, 429);
    assert.equal(denied.json.reason, 'quota_exceeded');
    assert.equal(mem.byKey.size, before, 'over-limit token write creates no event');
  });

  it('402 for lapsed tenant explains upgrade, creates no event', async () => {
    statuses.set('demo-tenant', 'past_due');
    const before = mem.byKey.size;
    const r = await post('demo-tenant', randomUUID(), {});
    assert.equal(r.status, 402);
    assert.equal(r.json.reason, 'upgrade_required');
    assert.match(String(r.json.message), /upgrade|payment|billing|subscription/i);
    assert.equal(mem.byKey.size, before, '402 creates no event');
  });

  it('replay of same key at limit returns original 200 deduped (no second event)', async () => {
    mem.seedApi('demo-tenant', 999);
    const key = randomUUID();
    const first = await post('demo-tenant', key, {});
    assert.equal(first.status, 200); // 1000th, last allowed
    const second = await post('demo-tenant', key, {});
    assert.equal(second.status, 200);
    assert.deepEqual(second.json.usage, first.json.usage);
    assert.equal(second.json.deduped, true);
    assert.equal(await mem.countApiUsage('demo-tenant'), 1000);
  });

  it('tenant isolation: tenant at limit 429, other tenant 200', async () => {
    mem.seedApi('demo-tenant', 1000);
    const denied = await post('demo-tenant', randomUUID(), {});
    assert.equal(denied.status, 429);
    const ok = await post('other-tenant', randomUUID(), {});
    assert.equal(ok.status, 200);
  });
});
