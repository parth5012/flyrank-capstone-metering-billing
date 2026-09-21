// Billing sync tests (P3-T4): verify applyStripeEvent handling of Stripe webhook events.
// Test doubles use in-memory Maps (no DB, no network):
// - checkout.session.completed flips tenant plan free -> pro and inserts subscription
// - replay (idempotency: calling applyStripeEvent twice) preserves single subscription and pro plan
// - customer.subscription.updated syncs subscription status and period
// - customer.subscription.deleted downgrades tenant plan to free and sets subscription canceled
// - unknown event type returns { applied: false }
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStripeEvent,
  type BillingDeps,
  type StripeEventLike,
} from '../src/services/billing';
import type { Tenant } from '../src/repos/tenant';

interface StoredSubscription {
  tenantId: string;
  stripeSubscriptionId: string;
  status: string;
  currentPeriodEnd?: string | null;
}

function createMockDeps() {
  const tenants = new Map<string, Tenant>();
  const subscriptions = new Map<string, StoredSubscription>();

  const deps: BillingDeps = {
    findTenant: async (tenantId: string) => {
      return tenants.get(tenantId) ?? null;
    },
    updateTenantPlan: async (tenantId, plan, stripeCustomerId, status) => {
      const existing = tenants.get(tenantId);
      if (!existing) return null;
      const updated: Tenant = {
        ...existing,
        plan,
        stripe_customer_id:
          stripeCustomerId !== undefined && stripeCustomerId !== null
            ? stripeCustomerId
            : existing.stripe_customer_id,
        status: status !== undefined && status !== null ? status : existing.status,
      };
      tenants.set(tenantId, updated);
      return updated;
    },
    upsertSubscription: async (input) => {
      subscriptions.set(input.stripeSubscriptionId, {
        tenantId: input.tenantId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        status: input.status,
        currentPeriodEnd: input.currentPeriodEnd ?? null,
      });
    },
  };

  return { tenants, subscriptions, deps };
}

describe('BillingService.applyStripeEvent (P3-T4)', () => {
  it('completed flips free->pro + sub inserted', async () => {
    const { tenants, subscriptions, deps } = createMockDeps();
    tenants.set('demo-tenant', {
      id: 'demo-tenant',
      name: 'Demo Tenant',
      plan: 'free',
      stripe_customer_id: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const event: StripeEventLike = {
      id: 'evt_checkout_completed_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_123',
          client_reference_id: 'demo-tenant',
          customer: 'cus_test_123',
          subscription: 'sub_test_123',
        },
      },
    };

    const res = await applyStripeEvent(event, deps);
    assert.equal(res.applied, true);
    assert.equal(res.tenantId, 'demo-tenant');

    const tenant = tenants.get('demo-tenant');
    assert.ok(tenant);
    assert.equal(tenant.plan, 'pro');
    assert.equal(tenant.stripe_customer_id, 'cus_test_123');

    const sub = subscriptions.get('sub_test_123');
    assert.ok(sub);
    assert.equal(sub.tenantId, 'demo-tenant');
    assert.equal(sub.stripeSubscriptionId, 'sub_test_123');
    assert.equal(sub.status, 'active');
    assert.equal(subscriptions.size, 1);
  });

  it('replay (call apply twice) -> still one sub row + plan stays pro', async () => {
    const { tenants, subscriptions, deps } = createMockDeps();
    tenants.set('demo-tenant', {
      id: 'demo-tenant',
      name: 'Demo Tenant',
      plan: 'free',
      stripe_customer_id: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const event: StripeEventLike = {
      id: 'evt_checkout_completed_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_123',
          client_reference_id: 'demo-tenant',
          customer: 'cus_test_123',
          subscription: 'sub_test_123',
        },
      },
    };

    const first = await applyStripeEvent(event, deps);
    assert.equal(first.applied, true);

    const second = await applyStripeEvent(event, deps);
    assert.equal(second.applied, true);

    const tenant = tenants.get('demo-tenant');
    assert.ok(tenant);
    assert.equal(tenant.plan, 'pro');
    assert.equal(subscriptions.size, 1);
  });

  it('updated syncs status/period', async () => {
    const { tenants, subscriptions, deps } = createMockDeps();
    tenants.set('demo-tenant', {
      id: 'demo-tenant',
      name: 'Demo Tenant',
      plan: 'pro',
      stripe_customer_id: 'cus_test_123',
      status: 'active',
      created_at: new Date().toISOString(),
    });
    subscriptions.set('sub_test_123', {
      tenantId: 'demo-tenant',
      stripeSubscriptionId: 'sub_test_123',
      status: 'active',
      currentPeriodEnd: '2026-01-01T00:00:00.000Z',
    });

    const nextPeriodEnd = '2026-02-01T00:00:00.000Z';
    const event: StripeEventLike = {
      id: 'evt_sub_updated_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test_123',
          customer: 'cus_test_123',
          status: 'past_due',
          current_period_end: nextPeriodEnd,
          metadata: {
            tenant_id: 'demo-tenant',
          },
        },
      },
    };

    const res = await applyStripeEvent(event, deps);
    assert.equal(res.applied, true);
    assert.equal(res.tenantId, 'demo-tenant');

    const sub = subscriptions.get('sub_test_123');
    assert.ok(sub);
    assert.equal(sub.status, 'past_due');
    assert.equal(sub.currentPeriodEnd, nextPeriodEnd);

    const tenant = tenants.get('demo-tenant');
    assert.ok(tenant);
    assert.equal(tenant.status, 'past_due');
  });

  it('updated syncs status/period with numeric unix timestamp', async () => {
    const { tenants, subscriptions, deps } = createMockDeps();
    tenants.set('demo-tenant', {
      id: 'demo-tenant',
      name: 'Demo Tenant',
      plan: 'pro',
      stripe_customer_id: 'cus_test_123',
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const unixSeconds = 1769904000;
    const event: StripeEventLike = {
      id: 'evt_sub_updated_num',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test_123',
          customer: 'cus_test_123',
          status: 'active',
          current_period_end: unixSeconds,
          metadata: {
            tenant_id: 'demo-tenant',
          },
        },
      },
    };

    const res = await applyStripeEvent(event, deps);
    assert.equal(res.applied, true);

    const sub = subscriptions.get('sub_test_123');
    assert.ok(sub);
    assert.equal(sub.currentPeriodEnd, new Date(unixSeconds * 1000).toISOString());
  });

  it('deleted downgrades to free', async () => {
    const { tenants, subscriptions, deps } = createMockDeps();
    tenants.set('demo-tenant', {
      id: 'demo-tenant',
      name: 'Demo Tenant',
      plan: 'pro',
      stripe_customer_id: 'cus_test_123',
      status: 'active',
      created_at: new Date().toISOString(),
    });
    subscriptions.set('sub_test_123', {
      tenantId: 'demo-tenant',
      stripeSubscriptionId: 'sub_test_123',
      status: 'active',
      currentPeriodEnd: '2026-01-01T00:00:00.000Z',
    });

    const event: StripeEventLike = {
      id: 'evt_sub_deleted_1',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_test_123',
          customer: 'cus_test_123',
          status: 'canceled',
          metadata: {
            tenant_id: 'demo-tenant',
          },
        },
      },
    };

    const res = await applyStripeEvent(event, deps);
    assert.equal(res.applied, true);
    assert.equal(res.tenantId, 'demo-tenant');

    const tenant = tenants.get('demo-tenant');
    assert.ok(tenant);
    assert.equal(tenant.plan, 'free');
    assert.equal(tenant.status, 'canceled');

    const sub = subscriptions.get('sub_test_123');
    assert.ok(sub);
    assert.equal(sub.status, 'canceled');
  });

  it('unknown type applied:false', async () => {
    const { deps } = createMockDeps();
    const event: StripeEventLike = {
      id: 'evt_invoice_1',
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: 'in_test_123',
        },
      },
    };

    const res = await applyStripeEvent(event, deps);
    assert.equal(res.applied, false);
  });

  it('checkout.session.completed with metadata.tenant_id fallback', async () => {
    const { tenants, subscriptions, deps } = createMockDeps();
    tenants.set('demo-tenant', {
      id: 'demo-tenant',
      name: 'Demo Tenant',
      plan: 'free',
      stripe_customer_id: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const event: StripeEventLike = {
      id: 'evt_cs_meta',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_meta_1',
          customer: 'cus_meta_1',
          subscription: { id: 'sub_meta_1' },
          metadata: {
            tenant_id: 'demo-tenant',
          },
        },
      },
    };

    const res = await applyStripeEvent(event, deps);
    assert.equal(res.applied, true);
    assert.equal(res.tenantId, 'demo-tenant');
    assert.equal(tenants.get('demo-tenant')?.plan, 'pro');
    assert.equal(subscriptions.get('sub_meta_1')?.status, 'active');
  });

  it('missing tenant_id returns applied:false', async () => {
    const { deps } = createMockDeps();
    const event: StripeEventLike = {
      id: 'evt_no_tenant',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_no_tenant',
          customer: 'cus_1',
        },
      },
    };

    const res = await applyStripeEvent(event, deps);
    assert.equal(res.applied, false);
  });
});
