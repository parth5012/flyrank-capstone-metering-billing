// P3-T2 POST /checkout tests: create Stripe Checkout session for Pro subscription.
// Validates {tenant_id} (4xx never 500), checks tenant existence (unknown -> 404),
// enforces test mode (sk_test_), passes required params (mode subscription,
// Pro price, success/cancel URLs, client_reference_id, metadata), returns {checkout_url}.
// Secrets stay server-side. In-memory/mock doubles (no live Stripe network calls).
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type Stripe from 'stripe';
import { createApp } from '../src/app';
import { setCheckoutDeps } from '../src/routes/checkout';
import type { Tenant } from '../src/repos/tenant';

const MOCK_PRO_PRICE_ID = 'price_test_pro_123';
const MOCK_CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_mock_abc123';
const MOCK_SESSION_ID = 'cs_test_mock_abc123';

describe('POST /checkout (P3-T2)', () => {
  let server: Server;
  let base = '';
  let capturedSessionParams: Stripe.Checkout.SessionCreateParams | null = null;
  const tenants = new Map<string, Tenant>();

  before(async () => {
    tenants.set('demo-tenant', {
      id: 'demo-tenant',
      name: 'Demo Tenant',
      plan: 'free',
      stripe_customer_id: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    tenants.set('cust-tenant', {
      id: 'cust-tenant',
      name: 'Customer Tenant',
      plan: 'free',
      stripe_customer_id: 'cus_existing_123',
      status: 'active',
      created_at: new Date().toISOString(),
    });

    setCheckoutDeps({
      findTenant: async (id: string) => tenants.get(id) ?? null,
      createSession: async (params: Stripe.Checkout.SessionCreateParams) => {
        capturedSessionParams = params;
        return { url: MOCK_CHECKOUT_URL, id: MOCK_SESSION_ID };
      },
      getStripeSecretKey: () => 'sk_test_mock_key_123',
      getProPriceId: () => MOCK_PRO_PRICE_ID,
      getBaseUrl: () => 'http://localhost:3000',
    });

    const app = createApp();
    server = app.listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    setCheckoutDeps(null);
    server.close();
    await once(server, 'close');
  });

  beforeEach(() => {
    capturedSessionParams = null;
    // Reset default mock wiring before each test
    setCheckoutDeps({
      findTenant: async (id: string) => tenants.get(id) ?? null,
      createSession: async (params: Stripe.Checkout.SessionCreateParams) => {
        capturedSessionParams = params;
        return { url: MOCK_CHECKOUT_URL, id: MOCK_SESSION_ID };
      },
      getStripeSecretKey: () => 'sk_test_mock_key_123',
      getProPriceId: () => MOCK_PRO_PRICE_ID,
      getBaseUrl: () => 'http://localhost:3000',
    });
  });

  async function postCheckout(body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${base}/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  }

  describe('validation (4xx never 500)', () => {
    it('missing body -> 400', async () => {
      const { status, json } = await postCheckout(undefined);
      assert.equal(status, 400);
      assert.notEqual(status, 500);
      assert.ok(json.error !== undefined || json.message !== undefined);
    });

    it('empty object -> 400', async () => {
      const { status, json } = await postCheckout({});
      assert.equal(status, 400);
      assert.notEqual(status, 500);
      assert.ok(json.error !== undefined || json.message !== undefined);
    });

    it('missing tenant_id -> 400', async () => {
      const { status, json } = await postCheckout({ other_field: 'value' });
      assert.equal(status, 400);
      assert.notEqual(status, 500);
      assert.ok(json.error !== undefined || json.message !== undefined);
    });

    it('empty string tenant_id -> 400', async () => {
      const { status, json } = await postCheckout({ tenant_id: '' });
      assert.equal(status, 400);
      assert.notEqual(status, 500);
    });

    it('whitespace-only tenant_id -> 400', async () => {
      const { status, json } = await postCheckout({ tenant_id: '   ' });
      assert.equal(status, 400);
      assert.notEqual(status, 500);
    });

    it('non-string tenant_id -> 400', async () => {
      const { status, json } = await postCheckout({ tenant_id: 12345 });
      assert.equal(status, 400);
      assert.notEqual(status, 500);
    });
  });

  describe('tenant lookup (unknown -> 404)', () => {
    it('unknown tenant -> 404', async () => {
      const { status, json } = await postCheckout({ tenant_id: 'unknown-tenant-xyz' });
      assert.equal(status, 404);
      assert.equal(json.error, 'unknown_tenant');
      assert.match(String(json.message), /unknown tenant/i);
    });
  });

  describe('configuration & security (500 on env failure, secrets server-side)', () => {
    it('missing STRIPE_PRO_PRICE_ID -> 500 with configuration_error', async () => {
      setCheckoutDeps({
        findTenant: async (id: string) => tenants.get(id) ?? null,
        getProPriceId: () => undefined,
      });
      const { status, json } = await postCheckout({ tenant_id: 'demo-tenant' });
      assert.equal(status, 500);
      assert.equal(json.error, 'configuration_error');
      assert.match(String(json.message), /STRIPE_PRO_PRICE_ID/i);
    });

    it('live key rejected (sk_live_...) -> 500 with configuration_error', async () => {
      setCheckoutDeps({
        findTenant: async (id: string) => tenants.get(id) ?? null,
        getStripeSecretKey: () => 'sk_live_dangerous_real_money_key',
      });
      const { status, json } = await postCheckout({ tenant_id: 'demo-tenant' });
      assert.equal(status, 500);
      assert.equal(json.error, 'configuration_error');
      assert.match(String(json.message), /test mode/i);
    });

    it('validation failure runs before env check (never 500 on invalid input)', async () => {
      setCheckoutDeps({
        findTenant: async (id: string) => tenants.get(id) ?? null,
        getProPriceId: () => undefined,
        getStripeSecretKey: () => undefined,
      });
      const { status } = await postCheckout({});
      assert.equal(status, 400, 'validation failure must stay 400 even with missing env');
    });

    it('validation failure runs before tenant lookup (never 404 on missing body)', async () => {
      const { status } = await postCheckout({});
      assert.equal(status, 400);
    });

    it('session creation returning null url -> 500', async () => {
      setCheckoutDeps({
        findTenant: async (id: string) => tenants.get(id) ?? null,
        createSession: async () => ({ url: null }),
      });
      const { status, json } = await postCheckout({ tenant_id: 'demo-tenant' });
      assert.equal(status, 500);
      assert.equal(json.error, 'checkout_session_failed');
    });
  });

  describe('happy path (200 with checkout_url)', () => {
    it('creates session and returns checkout_url', async () => {
      const { status, json } = await postCheckout({ tenant_id: 'demo-tenant' });
      assert.equal(status, 200);
      assert.equal(json.checkout_url, MOCK_CHECKOUT_URL);
    });

    it('passes required Stripe session parameters (mode, line_items, URLs, metadata)', async () => {
      const { status } = await postCheckout({ tenant_id: 'demo-tenant' });
      assert.equal(status, 200);
      assert.ok(capturedSessionParams !== null, 'createSession was called');

      const p = capturedSessionParams!;
      assert.equal(p.mode, 'subscription');
      assert.deepEqual(p.line_items, [{ price: MOCK_PRO_PRICE_ID, quantity: 1 }]);
      assert.equal(p.success_url, 'http://localhost:3000/checkout/success?session_id={CHECKOUT_SESSION_ID}');
      assert.equal(p.cancel_url, 'http://localhost:3000/checkout/cancel');
      assert.equal(p.client_reference_id, 'demo-tenant');
      assert.deepEqual(p.metadata, { tenant_id: 'demo-tenant' });
      assert.equal(p.customer, undefined, 'no customer when stripe_customer_id is null');
    });

    it('attaches existing stripe_customer_id if tenant already has one', async () => {
      const { status } = await postCheckout({ tenant_id: 'cust-tenant' });
      assert.equal(status, 200);
      assert.ok(capturedSessionParams !== null);
      assert.equal(capturedSessionParams!.customer, 'cus_existing_123');
      assert.equal(capturedSessionParams!.client_reference_id, 'cust-tenant');
      assert.deepEqual(capturedSessionParams!.metadata, { tenant_id: 'cust-tenant' });
    });

    it('never leaks secret key in response or headers', async () => {
      const res = await fetch(`${base}/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenant_id: 'demo-tenant' }),
      });
      const text = await res.text();
      assert.ok(!text.includes('sk_test_'), 'response body must never contain secret key');
      assert.ok(!text.includes('sk_live_'), 'response body must never contain secret key');
      for (const [header, val] of res.headers.entries()) {
        assert.ok(!val.includes('sk_test_'), `header ${header} must not contain secret key`);
      }
    });
  });
});
