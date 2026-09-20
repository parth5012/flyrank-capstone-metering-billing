// MeterService.record (P2-T3): idempotent usage insert.
// DB UNIQUE(idempotency_key) + INSERT ... ON CONFLICT DO NOTHING
// RETURNING (DESIGN.md §5). Conflict returns the original row — no new
// event, no cost change. Concurrency safety comes from the DB UNIQUE
// constraint, never an app-level check. Quota check deferred to P2-T4
// (QuotaService.check still stub); cost rollup deferred to Phase 4.
import { randomUUID } from 'node:crypto';
import {
  insertUsageEvent,
  type TokenBreakdown,
  type UsageEvent,
  type UsageType,
} from '../repos/usage';

export function notImplemented(phase: number | string): never {
  throw Object.assign(new Error('not_implemented'), { phase });
}

export interface TokenInput {
  input?: number;
  cached_input?: number;
  output?: number;
  reasoning?: number;
}

export interface RecordUsageInput {
  tenantId: string;
  idempotencyKey: string;
  tokens?: TokenInput;
}

export interface RecordDeps {
  insert: typeof insertUsageEvent;
  newId: () => string;
}

const defaultDeps: RecordDeps = { insert: insertUsageEvent, newId: randomUUID };

export async function recordUsage(
  input: RecordUsageInput,
  deps: Partial<RecordDeps> = {},
): Promise<{ event: UsageEvent; inserted: boolean }> {
  const { insert, newId } = { ...defaultDeps, ...deps };
  let type: UsageType = 'api_call';
  let qty = 1;
  let tokenBreakdown: TokenBreakdown | null = null;
  if (input.tokens !== undefined) {
    const t = input.tokens;
    const breakdown: TokenBreakdown = {
      input: t.input ?? 0,
      cached_input: t.cached_input ?? 0,
      output: t.output ?? 0,
      reasoning: t.reasoning ?? 0,
    };
    type = 'ai_token';
    qty = breakdown.input + breakdown.cached_input + breakdown.output + breakdown.reasoning;
    tokenBreakdown = breakdown;
  }
  return insert({
    id: newId(),
    tenantId: input.tenantId,
    type,
    qty,
    idempotencyKey: input.idempotencyKey,
    tokenBreakdown,
  });
}
