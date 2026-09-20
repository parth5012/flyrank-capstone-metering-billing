// tenants/plans/subscriptions repo (P2-T1 wiring).
// Tenant isolation: every query scopes by tenant id — no cross-tenant reads.
// Money stays integer cents (see src/config/pricing.ts); token_limit is
// BIGINT, read back as string per node-postgres convention.
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
