// tenants/plans/subscriptions repo (P2-T1 wiring).
// Tenant isolation: every query scopes by tenant id — no cross-tenant reads.
// Money stays integer cents (see src/config/pricing.ts); token_limit is
// BIGINT, read back as string per node-postgres convention.
import { randomUUID } from 'node:crypto';
import { query } from '../db';

export interface Tenant {
  id: string;
  name: string;
  plan: 'free' | 'pro';
  stripe_customer_id: string | null;
  status: string;
  created_at: string;
}

export interface Plan {
  id: string;
  name: string;
  api_limit: number;
  token_limit: string;
  price_cents: number;
}

const TENANT_COLS = 'id, name, plan, stripe_customer_id, status, created_at';
const PLAN_COLS = 'id, name, api_limit, token_limit, price_cents';

export async function findTenant(tenantId: string): Promise<Tenant | null> {
  const { rows } = await query<Tenant>(`SELECT ${TENANT_COLS} FROM tenants WHERE id = $1`, [
    tenantId,
  ]);
  return rows[0] ?? null;
}

export async function upsertTenant(input: {
  id: string;
  name: string;
  plan: 'free' | 'pro';
}): Promise<Tenant> {
  const { rows } = await query<Tenant>(
    `INSERT INTO tenants (id, name, plan) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
     RETURNING ${TENANT_COLS}`,
    [input.id, input.name, input.plan],
  );
  const row = rows[0];
  if (!row) throw new Error('upsertTenant returned no row');
  return row;
}

export async function upsertPlan(input: {
  id: string;
  name: string;
  apiLimit: number;
  tokenLimit: number;
  priceCents: number;
}): Promise<Plan> {
  const { rows } = await query<Plan>(
    `INSERT INTO plans (id, name, api_limit, token_limit, price_cents)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING
     RETURNING ${PLAN_COLS}`,
    [input.id, input.name, input.apiLimit, input.tokenLimit, input.priceCents],
  );
  if (rows[0]) return rows[0];
  // Already seeded — read back scoped by plan id.
  const existing = await query<Plan>(`SELECT ${PLAN_COLS} FROM plans WHERE id = $1`, [input.id]);
  const plan = existing.rows[0];
  if (!plan) throw new Error(`upsertPlan lost race for plan ${input.id}`);
  return plan;
}

export async function listPlans(): Promise<Plan[]> {
  const { rows } = await query<Plan>(`SELECT ${PLAN_COLS} FROM plans ORDER BY id`);
  return rows;
}

// Plan limits for quota (P2-T4): Pro limits read from plans table, never
// hardcoded at the route. token_limit is BIGINT — node-postgres returns it
// as string, callers coerce with Number().
export async function findPlan(planId: string): Promise<Plan | null> {
  const { rows } = await query<Plan>(`SELECT ${PLAN_COLS} FROM plans WHERE id = $1`, [
    planId,
  ]);
  return rows[0] ?? null;
}

export async function updateTenantPlan(
  tenantId: string,
  plan: 'free' | 'pro',
  stripeCustomerId?: string | null,
  status?: string,
): Promise<Tenant | null> {
  const { rows } = await query<Tenant>(
    `UPDATE tenants
     SET plan = $2,
         stripe_customer_id = COALESCE($3, stripe_customer_id),
         status = COALESCE($4, status)
     WHERE id = $1
     RETURNING ${TENANT_COLS}`,
    [tenantId, plan, stripeCustomerId ?? null, status ?? null],
  );
  return rows[0] ?? null;
}

export async function upsertSubscription(input: {
  tenantId: string;
  stripeSubscriptionId: string;
  status: string;
  currentPeriodEnd?: string | null;
}): Promise<void> {
  const id = randomUUID();
  await query(
    `INSERT INTO subscriptions (id, tenant_id, stripe_subscription_id, status, current_period_end)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET
       status = EXCLUDED.status,
       current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end)`,
    [
      id,
      input.tenantId,
      input.stripeSubscriptionId,
      input.status,
      input.currentPeriodEnd ?? null,
    ],
  );
}

export async function findTenantByStripeCustomerId(customerId: string): Promise<Tenant | null> {
  const { rows } = await query<Tenant>(
    `SELECT ${TENANT_COLS} FROM tenants WHERE stripe_customer_id = $1`,
    [customerId],
  );
  return rows[0] ?? null;
}

export async function findTenantIdBySubscription(stripeSubscriptionId: string): Promise<string | null> {
  const { rows } = await query<{ tenant_id: string }>(
    'SELECT tenant_id FROM subscriptions WHERE stripe_subscription_id = $1',
    [stripeSubscriptionId],
  );
  return rows[0]?.tenant_id ?? null;
}
