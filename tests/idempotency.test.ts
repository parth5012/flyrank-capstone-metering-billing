// P2-T3 idempotency tests (Probe 1 core): DB UNIQUE(idempotency_key) +
// INSERT ON CONFLICT DO NOTHING RETURNING. Conflict returns the original
// row: no new event, no cost change. Quota boundary deferred to P2-T4,
// cost math to Phase 4 — this file asserts record/dedup only.
//
// No Docker DB here: test doubles emulate UNIQUE + first-write-wins
// (same semantics as ON CONFLICT DO NOTHING). Live Postgres proof
// (double-curl + SELECT COUNT(*)=1, concurrent senders) deferred to P2-T7.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app';
import { recordUsage } from '../src/services/meter';
import { setGenerateDeps } from '../src/routes/generate';
import type { UsageEvent, TokenBreakdown } from '../src/repos/usage';

// In-memory double for insertUsageEvent: first-write-wins per
// idempotency_key (mirrors UNIQUE + ON CONFLICT DO NOTHING), lookup
// scoped to tenant_id (mirrors findUsageByIdempotencyKey).
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
      if (prior.tenant_id !== input.tenantId) {
        throw new Error(
          'usage insert conflicted but original row is not visible to this tenant',
        );
      }
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
  return { insert, findExisting, countApiUsage, sumTokenUsage, count: () => byKey.size, byKey };
}

describe('MeterService.record idempotent insert (P2-T3)', () => {
  it('same key twice -> 1 row, second mirrors first (no new event)', async () => {
    const mem = makeMemoryUsage();
    const key = randomUUID();
    const first = await recordUsage(
      { tenantId: 'demo-tenant', idempotencyKey: key },
      { insert: mem.insert },
    );
    const second = await recordUsage(
      { tenantId: 'demo-tenant', idempotencyKey: key },
      { insert: mem.insert },
    );
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(mem.count(), 1, 'SELECT COUNT(*) must be 1 after double-send');
    assert.deepEqual(second.event, first.event, 'conflict returns original row');
  });

  it('concurrent double-send safe -> 1 row, identical responses', async () => {
    const mem = makeMemoryUsage();
    const key = randomUUID();
    const [a, b] = await Promise.all([
      recordUsage({ tenantId: 'demo-tenant', idempotencyKey: key }, { insert: mem.insert }),
      recordUsage({ tenantId: 'demo-tenant', idempotencyKey: key }, { insert: mem.insert }),
    ]);
    assert.equal(mem.count(), 1, 'UNIQUE first-write-wins, not app check');
    assert.deepEqual(a.event, b.event);
    assert.ok(a.inserted !== b.inserted || mem.count() === 1);
  });

  it('token_breakdown JSONB stored for ai_token; api_call otherwise', async () => {
    const mem = makeMemoryUsage();
    const ai = await recordUsage(
      {
        tenantId: 'demo-tenant',
        idempotencyKey: randomUUID(),
        tokens: { input: 10, cached_input: 5, output: 20, reasoning: 3 },
      },
      { insert: mem.insert },
    );
    assert.equal(ai.event.type, 'ai_token');
    assert.equal(ai.event.qty, 38);
    assert.deepEqual(ai.event.token_breakdown, {
      input: 10,
      cached_input: 5,
      output: 20,
      reasoning: 3,
    });

    const api = await recordUsage(
      { tenantId: 'demo-tenant', idempotencyKey: randomUUID() },
      { insert: mem.insert },
    );
    assert.equal(api.event.type, 'api_call');
    assert.equal(api.event.qty, 1);
    assert.equal(api.event.token_breakdown, null);
  });
});

describe('POST /generate idempotent record (P2-T3, HTTP)', () => {
  let server: Server;
  let base = '';
  let mem = makeMemoryUsage();

  before(async () => {
    mem = makeMemoryUsage();
    setGenerateDeps({
      findTenant: async (id: string) =>
        id === 'demo-tenant'
          ? { id, name: 'Demo', plan: 'free' as const, stripe_customer_id: null, status: 'active', created_at: '' }
          : null,
      insert: mem.insert,
      // P2-T4 quota seam: counts derive from the same memory store so dedup
      // tests stay under quota (few rows << 1000 Free limit).
      findExisting: mem.findExisting,
      countApiUsage: mem.countApiUsage,
      sumTokenUsage: mem.sumTokenUsage,
      getPlanLimits: async () => ({ apiLimit: 1000, tokenLimit: 100000 }),
    });
    const app = createApp();
    server = app.listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    setGenerateDeps(null); // restore production wiring
    server.close();
    await once(server, 'close');
  });

  beforeEach(() => {
    mem.byKey.clear();
  });

  async function post(tenant: string, key: string, body: unknown = {}): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${base}/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenant,
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    });
    assert.notEqual(res.status, 500, 'never 500 from /generate');
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it('valid request -> 200 with usage (quota deferred to P2-T4)', async () => {
    const { status, json } = await post('demo-tenant', randomUUID(), {
      tokens: { input: 10, output: 5 },
    });
    assert.equal(status, 200);
    assert.equal(json.allowed, true);
    assert.ok(json.usage !== undefined, 'response carries recorded usage');
  });

  it('same key twice -> same usage, 1 row, replay flagged deduped', async () => {
    const key = randomUUID();
    const body = { tokens: { input: 10, cached_input: 5, output: 20, reasoning: 3 } };
    const first = await post('demo-tenant', key, body);
    const second = await post('demo-tenant', key, body);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.json.usage, first.json.usage, 'conflict returns original stored result');
    assert.equal(second.json.deduped, true);
    assert.equal(mem.count(), 1, '1 row after double-send');
  });

  it('concurrent same-key POSTs -> 1 row, identical usage', async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([
      post('demo-tenant', key, { tokens: { input: 7 } }),
      post('demo-tenant', key, { tokens: { input: 7 } }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(a.json.usage, b.json.usage);
    assert.equal(mem.count(), 1);
  });
});
