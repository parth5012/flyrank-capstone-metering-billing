// P2-T2 validation tests: 4xx never 500 from /generate. No DB, no Stripe.
// Covers: missing tenant, invalid/missing idempotency-key (uuidv4), negative /
// float tokens, unknown tenant -> 4xx; valid -> 200 via P2-T3 meter record
// (quota deferred to P2-T4). Route deps are in-memory doubles (no Docker DB;
// live-DB proof deferred to P2-T7).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app';
import { setGenerateDeps } from '../src/routes/generate';

let server: Server;
let base = '';

before(async () => {
  setGenerateDeps({
    findTenant: async (id: string) =>
      id === 'demo-tenant'
        ? {
            id,
            name: 'Demo',
            plan: 'free' as const,
            stripe_customer_id: null,
            status: 'active',
            created_at: '',
          }
        : null,
    insert: async (input) => ({
      event: {
        id: input.id,
        tenant_id: input.tenantId,
        type: input.type,
        qty: input.qty,
        idempotency_key: input.idempotencyKey,
        token_breakdown: input.tokenBreakdown ?? null,
        created_at: new Date().toISOString(),
      },
      inserted: true,
    }),
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

async function postGenerate(opts: {
  tenant?: string;
  key?: string;
  body?: unknown;
  rawBody?: string;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.tenant !== undefined) headers['x-tenant-id'] = opts.tenant;
  if (opts.key !== undefined) headers['idempotency-key'] = opts.key;
  const res = await fetch(`${base}/generate`, {
    method: 'POST',
    headers,
    body: opts.rawBody ?? JSON.stringify(opts.body ?? {}),
  });
  assert.notEqual(res.status, 500, 'never 500 from /generate');
  const json = (await res.json()) as Record<string, unknown>;
  if (res.status >= 400) {
    assert.ok(
      json.error !== undefined || json.message !== undefined,
      '4xx/5xx must carry {error/message}',
    );
  }
  return { status: res.status, json };
}

describe('POST /generate validation (P2-T2)', () => {
  it('missing tenant -> 400', async () => {
    const { status } = await postGenerate({ key: randomUUID(), body: {} });
    assert.equal(status, 400);
  });

  it('empty tenant -> 400', async () => {
    const { status } = await postGenerate({ tenant: '  ', key: randomUUID(), body: {} });
    assert.equal(status, 400);
  });

  it('missing idempotency-key -> 400', async () => {
    const { status } = await postGenerate({ tenant: 'demo-tenant', body: {} });
    assert.equal(status, 400);
  });

  it('invalid idempotency-key (non-uuid) -> 400', async () => {
    const { status } = await postGenerate({
      tenant: 'demo-tenant',
      key: 'not-a-uuid',
      body: {},
    });
    assert.equal(status, 400);
  });

  it('non-v4 uuid -> 400', async () => {
    const { status } = await postGenerate({
      tenant: 'demo-tenant',
      key: '6ec0bd7f-11c0-11f1-8c00-000000000000',
      body: {},
    });
    assert.equal(status, 400);
  });

  it('negative tokens -> 400', async () => {
    const { status } = await postGenerate({
      tenant: 'demo-tenant',
      key: randomUUID(),
      body: { tokens: { input: -1 } },
    });
    assert.equal(status, 400);
  });

  it('float tokens -> 400 (integers only)', async () => {
    const { status } = await postGenerate({
      tenant: 'demo-tenant',
      key: randomUUID(),
      body: { tokens: { output: 1.5 } },
    });
    assert.equal(status, 400);
  });

  it('string tokens -> 400 (no coercion)', async () => {
    const { status } = await postGenerate({
      tenant: 'demo-tenant',
      key: randomUUID(),
      body: { tokens: { input: '5' } },
    });
    assert.equal(status, 400);
  });

  it('unknown tenant -> 4xx', async () => {
    const { status } = await postGenerate({
      tenant: 'no-such-tenant-xyz-123',
      key: randomUUID(),
      body: {},
    });
    assert.ok(status >= 400 && status < 500, `expected 4xx got ${status}`);
  });

  it('valid request -> 200 with recorded usage (P2-T3 meter)', async () => {
    const { status, json } = await postGenerate({
      tenant: 'demo-tenant',
      key: randomUUID(),
      body: { tokens: { input: 10, cached_input: 5, output: 20, reasoning: 3 } },
    });
    assert.equal(status, 200);
    assert.equal(json.allowed, true);
    assert.ok(json.usage !== undefined);
  });

  it('valid headers + empty body -> 200 api_call (tokens optional)', async () => {
    const { status, json } = await postGenerate({ tenant: 'demo-tenant', key: randomUUID() });
    assert.equal(status, 200);
    assert.equal(json.allowed, true);
  });

  it('tenant isolation: unknown tenants stay 4xx, demo-tenant stays scoped 200', async () => {
    const a = await postGenerate({ tenant: 'tenant-a-unknown-xyz', key: randomUUID() });
    const b = await postGenerate({ tenant: 'tenant-b-unknown-xyz', key: randomUUID() });
    const valid = await postGenerate({ tenant: 'demo-tenant', key: randomUUID() });
    assert.ok(a.status >= 400 && a.status < 500);
    assert.ok(b.status >= 400 && b.status < 500);
    assert.equal(valid.status, 200);
  });
});
