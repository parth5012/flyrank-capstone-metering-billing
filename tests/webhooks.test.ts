// P3-T3 POST /webhooks/stripe signature verification tests:
// Verifies raw body with stripe-signature header against STRIPE_WEBHOOK_SECRET (whsec_).
// Forged or bad signature -> 400 with no DB writes or stripe_events inserted (Probe 4a).
// Missing signature header -> 400.
// Valid signed fixture -> 200 { received: true, id, type }.
// Uses Stripe.webhooks.generateTestHeaderString with whsec_test_... secret.
// Sends raw string bodies with application/json to exercise Buffer parsing path.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Stripe from 'stripe';
import { createApp } from '../src/app';
import { setWebhookDeps } from '../src/routes/webhooks';

const TEST_WEBHOOK_SECRET = 'whsec_test_mock_webhook_secret_12345';
const stripe = new Stripe('sk_test_mock_stripe_key_for_tests');

describe('POST /webhooks/stripe verification (P3-T3)', () => {
  let server: Server;
  let base = '';
  let markProcessedCalls: Array<{ eventId: string; type: string }> = [];

  const sampleEvent = {
    id: 'evt_test_checkout_completed_123',
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_abc123',
        object: 'checkout.session',
        client_reference_id: 'demo-tenant',
        customer: 'cus_test_cust_123',
        mode: 'subscription',
        subscription: 'sub_test_123',
      },
    },
  };

  const samplePayload = JSON.stringify(sampleEvent);

  before(async () => {
    setWebhookDeps({
      getWebhookSecret: () => TEST_WEBHOOK_SECRET,
      markProcessed: async (eventId: string, type: string) => {
        markProcessedCalls.push({ eventId, type });
        return true;
      },
    });

    const app = createApp();
    server = app.listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    setWebhookDeps(null);
    server.close();
    await once(server, 'close');
  });

  beforeEach(() => {
    markProcessedCalls = [];
    setWebhookDeps({
      getWebhookSecret: () => TEST_WEBHOOK_SECRET,
      markProcessed: async (eventId: string, type: string) => {
        markProcessedCalls.push({ eventId, type });
        return true;
      },
    });
  });

  async function postWebhook(opts: {
    rawBody?: string;
    signature?: string;
    contentType?: string;
  }): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
    const headers: Record<string, string> = {};
    if (opts.contentType !== undefined) {
      headers['content-type'] = opts.contentType;
    }
    if (opts.signature !== undefined) {
      headers['stripe-signature'] = opts.signature;
    }

    const res = await fetch(`${base}/webhooks/stripe`, {
      method: 'POST',
      headers,
      body: opts.rawBody,
    });

    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      // ignore non-json
    }
    return { status: res.status, json, text };
  }

  describe('signature header validation (missing/malformed -> 400)', () => {
    it('missing stripe-signature header -> 400', async () => {
      const { status, json } = await postWebhook({
        rawBody: samplePayload,
        contentType: 'application/json',
      });
      assert.equal(status, 400);
      assert.equal(json.error, 'missing_signature');
      assert.equal(markProcessedCalls.length, 0, 'no DB calls on missing signature');
    });

    it('empty string stripe-signature header -> 400', async () => {
      const { status, json } = await postWebhook({
        rawBody: samplePayload,
        signature: '',
        contentType: 'application/json',
      });
      assert.equal(status, 400);
      assert.equal(json.error, 'missing_signature');
      assert.equal(markProcessedCalls.length, 0);
    });

    it('whitespace-only stripe-signature header -> 400', async () => {
      const { status, json } = await postWebhook({
        rawBody: samplePayload,
        signature: '    ',
        contentType: 'application/json',
      });
      assert.equal(status, 400);
      assert.equal(json.error, 'missing_signature');
      assert.equal(markProcessedCalls.length, 0);
    });
  });

  describe('body & payload validation', () => {
    it('missing body -> 400', async () => {
      const header = stripe.webhooks.generateTestHeaderString({
        payload: '',
        secret: TEST_WEBHOOK_SECRET,
      });
      const { status, json } = await postWebhook({
        signature: header,
        contentType: 'application/json',
      });
      assert.equal(status, 400);
      assert.equal(json.error, 'invalid_payload');
      assert.equal(markProcessedCalls.length, 0);
    });

    it('empty body string -> 400', async () => {
      const header = stripe.webhooks.generateTestHeaderString({
        payload: '',
        secret: TEST_WEBHOOK_SECRET,
      });
      const { status, json } = await postWebhook({
        rawBody: '',
        signature: header,
        contentType: 'application/json',
      });
      assert.equal(status, 400);
      assert.equal(json.error, 'invalid_payload');
      assert.equal(markProcessedCalls.length, 0);
    });

    it('non-JSON body -> 400 bad_signature', async () => {
      const nonJson = 'not a valid json payload';
      const header = stripe.webhooks.generateTestHeaderString({
        payload: nonJson,
        secret: TEST_WEBHOOK_SECRET,
      });
      const { status, json } = await postWebhook({
        rawBody: nonJson,
        signature: header,
        contentType: 'application/json',
      });
      assert.equal(status, 400);
      assert.equal(json.error, 'bad_signature');
      assert.equal(markProcessedCalls.length, 0);
    });
  });

  describe('signature verification failure (forged/bad signature -> 400 + DB unchanged)', () => {
    it('forged signature header with invalid hash -> 400', async () => {
      const fakeSig = `t=${Math.floor(Date.now() / 1000)},v1=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`;
      const { status, json } = await postWebhook({
        rawBody: samplePayload,
        signature: fakeSig,
        contentType: 'application/json',
      });
      assert.equal(status, 400);
      assert.equal(json.error, 'bad_signature');
      assert.equal(markProcessedCalls.length, 0, 'zero stripe_events inserted on forged signature');
    });

    it('signature signed with wrong secret -> 400', async () => {
      const wrongSecretHeader = stripe.webhooks.generateTestHeaderString({
        payload: samplePayload,
        secret: 'whsec_different_secret_key_wrong_67890',
      });
      const { status, json } = await postWebhook({
        rawBody: samplePayload,
        signature: wrongSecretHeader,
        contentType: 'application/json',
      });
      assert.equal(status, 400);
      assert.equal(json.error, 'bad_signature');
      assert.equal(markProcessedCalls.length, 0, 'zero stripe_events inserted on wrong secret');
    });

    it('tampered payload (signature from different payload) -> 400', async () => {
      const header = stripe.webhooks.generateTestHeaderString({
        payload: samplePayload,
        secret: TEST_WEBHOOK_SECRET,
      });
      const tamperedPayload = JSON.stringify({
        ...sampleEvent,
        data: { object: { ...sampleEvent.data.object, client_reference_id: 'attacker-tenant' } },
      });
      const { status, json } = await postWebhook({
        rawBody: tamperedPayload,
        signature: header,
        contentType: 'application/json',
      });
      assert.equal(status, 400);
      assert.equal(json.error, 'bad_signature');
      assert.equal(markProcessedCalls.length, 0, 'zero stripe_events inserted on tampered payload');
    });

    it('expired timestamp (older than 5 min tolerance) -> 400', async () => {
      const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
      const expiredHeader = stripe.webhooks.generateTestHeaderString({
        payload: samplePayload,
        secret: TEST_WEBHOOK_SECRET,
        timestamp: tenMinutesAgo,
      });
      const { status, json } = await postWebhook({
        rawBody: samplePayload,
        signature: expiredHeader,
        contentType: 'application/json',
      });
      assert.equal(status, 400);
      assert.equal(json.error, 'bad_signature');
      assert.match(String(json.message), /timestamp/i);
      assert.equal(markProcessedCalls.length, 0, 'zero stripe_events inserted on expired timestamp');
    });
  });

  describe('configuration errors', () => {
    it('missing STRIPE_WEBHOOK_SECRET -> 500 when request is otherwise valid', async () => {
      setWebhookDeps({
        getWebhookSecret: () => undefined,
      });
      const header = stripe.webhooks.generateTestHeaderString({
        payload: samplePayload,
        secret: TEST_WEBHOOK_SECRET,
      });
      const { status, json } = await postWebhook({
        rawBody: samplePayload,
        signature: header,
        contentType: 'application/json',
      });
      assert.equal(status, 500);
      assert.equal(json.error, 'configuration_error');
      assert.match(String(json.message), /STRIPE_WEBHOOK_SECRET/i);
      assert.equal(markProcessedCalls.length, 0);
    });

    it('validation failure runs before env check (missing signature stays 400 even if env missing)', async () => {
      setWebhookDeps({
        getWebhookSecret: () => undefined,
      });
      const { status } = await postWebhook({
        rawBody: samplePayload,
        contentType: 'application/json',
      });
      assert.equal(status, 400, 'must return 400 not 500 when signature is missing');
      assert.equal(markProcessedCalls.length, 0);
    });
  });

  describe('valid signature verification (happy path -> 200)', () => {
    it('validly signed event -> 200 { received: true, id, type }', async () => {
      const validHeader = stripe.webhooks.generateTestHeaderString({
        payload: samplePayload,
        secret: TEST_WEBHOOK_SECRET,
      });
      const { status, json } = await postWebhook({
        rawBody: samplePayload,
        signature: validHeader,
        contentType: 'application/json',
      });
      assert.equal(status, 200);
      assert.equal(json.received, true);
      assert.equal(json.id, 'evt_test_checkout_completed_123');
      assert.equal(json.event_id, 'evt_test_checkout_completed_123');
      assert.equal(json.type, 'checkout.session.completed');
    });

    it('handles customer.subscription.updated event fixture', async () => {
      const subEvent = {
        id: 'evt_test_sub_updated_456',
        object: 'event',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_test_xyz',
            status: 'active',
            customer: 'cus_test_123',
          },
        },
      };
      const subPayload = JSON.stringify(subEvent);
      const validHeader = stripe.webhooks.generateTestHeaderString({
        payload: subPayload,
        secret: TEST_WEBHOOK_SECRET,
      });
      const { status, json } = await postWebhook({
        rawBody: subPayload,
        signature: validHeader,
        contentType: 'application/json',
      });
      assert.equal(status, 200);
      assert.equal(json.received, true);
      assert.equal(json.id, 'evt_test_sub_updated_456');
      assert.equal(json.type, 'customer.subscription.updated');
    });

    it('replay of same signed event still succeeds at verify layer (dedup in P3-T4)', async () => {
      const validHeader = stripe.webhooks.generateTestHeaderString({
        payload: samplePayload,
        secret: TEST_WEBHOOK_SECRET,
      });
      const res1 = await postWebhook({
        rawBody: samplePayload,
        signature: validHeader,
        contentType: 'application/json',
      });
      assert.equal(res1.status, 200);

      const res2 = await postWebhook({
        rawBody: samplePayload,
        signature: validHeader,
        contentType: 'application/json',
      });
      assert.equal(res2.status, 200);
      assert.equal(res2.json.received, true);
    });
  });
});
