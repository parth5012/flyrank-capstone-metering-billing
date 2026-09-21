// BillingService (P3-T4): Stripe webhook event processing.
// Syncs Stripe subscription and checkout events to local tenants and subscriptions tables.
// Idempotent: upserts only, safe on replay.
import * as tenantRepo from '../repos/tenant';

export interface StripeEventLike {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

export interface BillingDeps {
  findTenant: typeof tenantRepo.findTenant;
  updateTenantPlan: typeof tenantRepo.updateTenantPlan;
  upsertSubscription: typeof tenantRepo.upsertSubscription;
  findTenantByStripeCustomerId?: typeof tenantRepo.findTenantByStripeCustomerId;
  findTenantIdBySubscription?: typeof tenantRepo.findTenantIdBySubscription;
}

export const prodBillingDeps: BillingDeps = {
  findTenant: tenantRepo.findTenant,
  updateTenantPlan: tenantRepo.updateTenantPlan,
  upsertSubscription: tenantRepo.upsertSubscription,
  findTenantByStripeCustomerId: tenantRepo.findTenantByStripeCustomerId,
  findTenantIdBySubscription: tenantRepo.findTenantIdBySubscription,
};

function extractTenantId(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.client_reference_id === 'string' && obj.client_reference_id.trim()) {
    return obj.client_reference_id.trim();
  }
  if (
    typeof obj.metadata === 'object' &&
    obj.metadata !== null &&
    typeof (obj.metadata as Record<string, unknown>).tenant_id === 'string'
  ) {
    const metaTenant = ((obj.metadata as Record<string, unknown>).tenant_id as string).trim();
    if (metaTenant) return metaTenant;
  }
  return undefined;
}

function extractCustomerId(obj: Record<string, unknown>): string | null {
  if (typeof obj.customer === 'string' && obj.customer.trim()) {
    return obj.customer.trim();
  }
  if (
    typeof obj.customer === 'object' &&
    obj.customer !== null &&
    'id' in obj.customer &&
    typeof (obj.customer as { id: unknown }).id === 'string'
  ) {
    const id = (obj.customer as { id: string }).id.trim();
    if (id) return id;
  }
  return null;
}

function extractSubscriptionId(obj: Record<string, unknown>): string | null {
  if (typeof obj.subscription === 'string' && obj.subscription.trim()) {
    return obj.subscription.trim();
  }
  if (
    typeof obj.subscription === 'object' &&
    obj.subscription !== null &&
    'id' in obj.subscription &&
    typeof (obj.subscription as { id: unknown }).id === 'string'
  ) {
    const id = (obj.subscription as { id: string }).id.trim();
    if (id) return id;
  }
  if (typeof obj.id === 'string' && obj.id.startsWith('sub_')) {
    return obj.id.trim();
  }
  return null;
}

function extractPeriodEnd(obj: Record<string, unknown>): string | null {
  if (typeof obj.current_period_end === 'number' && Number.isFinite(obj.current_period_end)) {
    return new Date(obj.current_period_end * 1000).toISOString();
  }
  if (typeof obj.current_period_end === 'string' && obj.current_period_end.trim()) {
    return obj.current_period_end.trim();
  }
  return null;
}

async function resolveTenantId(
  obj: Record<string, unknown>,
  deps: BillingDeps,
): Promise<string | undefined> {
  const direct = extractTenantId(obj);
  if (direct) return direct;
  const customerId = extractCustomerId(obj);
  if (customerId && deps.findTenantByStripeCustomerId) {
    const tenant = await deps.findTenantByStripeCustomerId(customerId);
    if (tenant) return tenant.id;
  }
  const subscriptionId = extractSubscriptionId(obj) ?? (typeof obj.id === 'string' ? obj.id : null);
  if (subscriptionId && deps.findTenantIdBySubscription) {
    const tenantId = await deps.findTenantIdBySubscription(subscriptionId);
    if (tenantId) return tenantId;
  }
  return undefined;
}

export async function applyStripeEvent(
  event: StripeEventLike,
  deps: BillingDeps = prodBillingDeps,
): Promise<{ applied: boolean; tenantId?: string }> {
  if (!event || !event.type || !event.data || !event.data.object || typeof event.data.object !== 'object') {
    return { applied: false };
  }

  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      const tenantId = await resolveTenantId(obj, deps);
      if (!tenantId) {
        return { applied: false };
      }
      const tenant = await deps.findTenant(tenantId);
      if (!tenant) {
        return { applied: false };
      }

      const customerId = extractCustomerId(obj);
      const subscriptionId = extractSubscriptionId(obj);

      await deps.updateTenantPlan(tenantId, 'pro', customerId, 'active');
      if (subscriptionId) {
        await deps.upsertSubscription({
          tenantId,
          stripeSubscriptionId: subscriptionId,
          status: 'active',
        });
      }

      return { applied: true, tenantId };
    }

    case 'customer.subscription.updated': {
      const subId =
        (typeof obj.id === 'string' && obj.id.trim()) ||
        extractSubscriptionId(obj);
      let tenantId = extractTenantId(obj);
      if (!tenantId) {
        tenantId = await resolveTenantId(obj, deps);
      }

      if (!tenantId || !subId) {
        return { applied: false };
      }
      const tenant = await deps.findTenant(tenantId);
      if (!tenant) {
        return { applied: false };
      }

      const customerId = extractCustomerId(obj);
      const status = typeof obj.status === 'string' && obj.status.trim() ? obj.status.trim() : 'active';
      const plan: 'free' | 'pro' = status === 'canceled' || status === 'unpaid' ? 'free' : 'pro';
      const currentPeriodEnd = extractPeriodEnd(obj);

      await deps.updateTenantPlan(tenantId, plan, customerId, status);
      await deps.upsertSubscription({
        tenantId,
        stripeSubscriptionId: subId,
        status,
        currentPeriodEnd,
      });

      return { applied: true, tenantId };
    }

    case 'customer.subscription.deleted': {
      let tenantId = extractTenantId(obj);
      if (!tenantId) {
        tenantId = await resolveTenantId(obj, deps);
      }
      if (!tenantId) {
        return { applied: false };
      }
      const tenant = await deps.findTenant(tenantId);
      if (!tenant) {
        return { applied: false };
      }

      const customerId = extractCustomerId(obj);
      const subId =
        (typeof obj.id === 'string' && obj.id.trim()) ||
        extractSubscriptionId(obj);
      const currentPeriodEnd = extractPeriodEnd(obj);

      await deps.updateTenantPlan(tenantId, 'free', customerId, 'canceled');
      if (subId) {
        await deps.upsertSubscription({
          tenantId,
          stripeSubscriptionId: subId,
          status: 'canceled',
          currentPeriodEnd,
        });
      }

      return { applied: true, tenantId };
    }

    default:
      return { applied: false };
  }
}

export async function syncSubscription(
  event: StripeEventLike,
  deps: BillingDeps = prodBillingDeps,
): Promise<{ applied: boolean; tenantId?: string }> {
  return applyStripeEvent(event, deps);
}
