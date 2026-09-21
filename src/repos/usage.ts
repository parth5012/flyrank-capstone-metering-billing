// usage_events repo (P2-T1 wiring). Every query filters tenant_id.
// Idempotency (DESIGN.md §5): UNIQUE(idempotency_key) +
// INSERT ... ON CONFLICT DO NOTHING RETURNING — conflict returns the
// original row, no new event, no cost change. Quota math lands in P2-T2.
import { query } from '../db';

export type UsageType = 'api_call' | 'ai_token';

export interface TokenBreakdown {
  input: number;
  cached_input: number;
  output: number;
  reasoning: number;
}

export interface UsageEvent {
  id: string;
  tenant_id: string;
  type: UsageType;
  qty: number;
  idempotency_key: string;
  token_breakdown: TokenBreakdown | null;
  created_at: string;
}

export interface InsertUsageInput {
  id: string;
  tenantId: string;
  type: UsageType;
  qty: number;
  idempotencyKey: string;
  tokenBreakdown?: TokenBreakdown | null;
}

const COLS = 'id, tenant_id, type, qty, idempotency_key, token_breakdown, created_at';

export async function insertUsageEvent(
  input: InsertUsageInput,
): Promise<{ event: UsageEvent; inserted: boolean }> {
  const { rows } = await query<UsageEvent>(
    `INSERT INTO usage_events (id, tenant_id, type, qty, idempotency_key, token_breakdown)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING ${COLS}`,
    [
      input.id,
      input.tenantId,
      input.type,
      input.qty,
      input.idempotencyKey,
      (input.tokenBreakdown ?? null) as unknown,
    ],
  );
  const inserted = rows[0];
  if (inserted) return { event: inserted, inserted: true };
  // Conflict: return the original row — scoped to this tenant so a key from
  // another tenant never leaks across (same key, different tenant = invisible).
  const original = await findUsageByIdempotencyKey(input.tenantId, input.idempotencyKey);
  if (!original) {
    const err = new Error('idempotency_key conflict') as Error & { status?: number };
    err.status = 409;
    throw err;
  }
  return { event: original, inserted: false };
}

export async function findUsageByIdempotencyKey(
  tenantId: string,
  idempotencyKey: string,
): Promise<UsageEvent | null> {
  const { rows } = await query<UsageEvent>(
    `SELECT ${COLS} FROM usage_events WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey],
  );
  return rows[0] ?? null;
}

export async function countUsageByTenant(tenantId: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM usage_events WHERE tenant_id = $1',
    [tenantId],
  );
  return Number(rows[0]?.count ?? 0);
}

// Token quota (P2-T4): sum of ai_token qty scoped to tenant. api_limit is
// COUNT(*) (every request = 1 event); token_limit is SUM(qty) over ai_token.
export async function sumTokensByTenant(tenantId: string): Promise<number> {
  const { rows } = await query<{ sum: string | null }>(
    `SELECT COALESCE(SUM(qty), 0)::text AS sum FROM usage_events
      WHERE tenant_id = $1 AND type = 'ai_token'`,
    [tenantId],
  );
  return Number(rows[0]?.sum ?? 0);
}

// Per-category token sums for CostService.rollup (P4-T2). Rollup sums per
// category, never raw tokens (DESIGN.md §6); this query feeds those sums so
// cost math stays sum-numerators-then-single-floor. Tenant-scoped like all
// reads here; events without a breakdown contribute 0.
export async function sumTokenBreakdownsByTenant(tenantId: string): Promise<TokenBreakdown> {
  const { rows } = await query<{
    input: string | null;
    cached_input: string | null;
    output: string | null;
    reasoning: string | null;
  }>(
    `SELECT COALESCE(SUM((token_breakdown->>'input')::bigint), 0)::text AS input,
            COALESCE(SUM((token_breakdown->>'cached_input')::bigint), 0)::text AS cached_input,
            COALESCE(SUM((token_breakdown->>'output')::bigint), 0)::text AS output,
            COALESCE(SUM((token_breakdown->>'reasoning')::bigint), 0)::text AS reasoning
       FROM usage_events
      WHERE tenant_id = $1 AND type = 'ai_token' AND token_breakdown IS NOT NULL`,
    [tenantId],
  );
  const row = rows[0];
  return {
    input: Number(row?.input ?? 0),
    cached_input: Number(row?.cached_input ?? 0),
    output: Number(row?.output ?? 0),
    reasoning: Number(row?.reasoning ?? 0),
  };
}
