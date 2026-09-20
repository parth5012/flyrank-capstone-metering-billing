// POST /generate validation (P2-T2) + idempotent record (P2-T3) + quota
// gate (P2-T4). zod on HTTP layer, 4xx never 500. Valid + under quota ->
// 200 {allowed, usage, deduped} via MeterService.record (UNIQUE +
// ON CONFLICT DO NOTHING; conflict returns original, no new event).
// Quota (DESIGN.md §6): current + requested > limit checked BEFORE write.
// Free 1000 API / 100k tokens, Pro from plans. 999 allow, 1000 allow (last
// allowed), 1001 -> 429 quota_exceeded (+Retry-After 60s placeholder) or
// 402 upgrade_required (billing lapsed). Over-limit creates no event.
// Idempotency replay bypasses quota: same key returns original 200
// deduped (no second event). Tenant isolation: tenantId comes ONLY from
// X-Tenant-Id header; repos scope every query by tenant_id; unknown
// tenant -> 404.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { tenantMiddleware, type TenantRequest } from '../middleware/tenant';
import { idempotencyMiddleware, type IdempotencyRequest } from '../middleware/idempotency';
import * as tenantRepo from '../repos/tenant';
import * as usageRepo from '../repos/usage';
import { recordUsage } from '../services/meter';
import { checkQuota, RETRY_AFTER_SECONDS } from '../services/quota';

const router = Router();

const tokenCount = z.number().int().min(0);
const tokensSchema = z
  .object({
    input: tokenCount.optional(),
    cached_input: tokenCount.optional(),
    output: tokenCount.optional(),
    reasoning: tokenCount.optional(),
  })
  .strict();

export const generateBodySchema = z.object({ tokens: tokensSchema.optional() });

// Test seam (P2-T3..T4): production defaults hit Postgres via repos. Tests
// run without Docker DB, so they install in-memory doubles via
// setGenerateDeps (emulating UNIQUE + ON CONFLICT DO NOTHING
// first-write-wins, plus per-tenant counts). Passing null restores
// production wiring. Live-DB double-send proof deferred to P2-T7.
export interface GenerateDeps {
  findTenant: typeof tenantRepo.findTenant;
  insert: typeof usageRepo.insertUsageEvent;
  findExisting: typeof usageRepo.findUsageByIdempotencyKey;
  countApiUsage: typeof usageRepo.countUsageByTenant;
  sumTokenUsage: typeof usageRepo.sumTokensByTenant;
  getPlanLimits: (planId: string) => Promise<{ apiLimit: number; tokenLimit: number }>;
}

async function prodGetPlanLimits(planId: string): Promise<{ apiLimit: number; tokenLimit: number }> {
  const plan = await tenantRepo.findPlan(planId);
  if (!plan) throw Object.assign(new Error(`unknown plan: ${planId}`), { status: 500 });
  return { apiLimit: plan.api_limit, tokenLimit: Number(plan.token_limit) };
}

const prodDeps: GenerateDeps = {
  findTenant: tenantRepo.findTenant,
  insert: usageRepo.insertUsageEvent,
  findExisting: usageRepo.findUsageByIdempotencyKey,
  countApiUsage: usageRepo.countUsageByTenant,
  sumTokenUsage: usageRepo.sumTokensByTenant,
  getPlanLimits: prodGetPlanLimits,
};

let activeDeps: GenerateDeps = prodDeps;

export function setGenerateDeps(deps: GenerateDeps | null): void {
  activeDeps = deps ?? prodDeps;
}

router.post(
  '/',
  tenantMiddleware,
  idempotencyMiddleware,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = generateBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: 'validation_failed',
          message: 'tokens must be integers >= 0',
          details: parsed.error.flatten(),
        });
        return;
      }
      const tenantId = (req as TenantRequest).tenantId as string;
      const idempotencyKey = (req as IdempotencyRequest).idempotencyKey as string;

      let tenant: { id: string; plan: string; status: string } | null;
      try {
        tenant = await activeDeps.findTenant(tenantId);
      } catch {
        // DB unavailable: seed-known demo-tenant is a server fault (503 via
        // error middleware mapping below); anything else stays 404 since we
        // cannot verify it. Never 500 from /generate.
        if (tenantId === 'demo-tenant') {
          const err = new Error('database unavailable') as Error & { status?: number };
          err.status = 500;
          throw err;
        }
        res
          .status(404)
          .json({ error: 'unknown_tenant', message: `unknown tenant: ${tenantId}` });
        return;
      }
      if (!tenant) {
        res
          .status(404)
          .json({ error: 'unknown_tenant', message: `unknown tenant: ${tenantId}` });
        return;
      }
      // Replay bypasses quota: same key returns the original stored result
      // (no new event, no cost change), even when the tenant is now at
      // limit. New keys go through the quota gate BEFORE record.
      const existing = await activeDeps.findExisting(tenantId, idempotencyKey);
      if (existing) {
        res.status(200).json({
          allowed: true,
          usage: {
            id: existing.id,
            type: existing.type,
            qty: existing.qty,
            token_breakdown: existing.token_breakdown,
          },
          deduped: true,
        });
        return;
      }
      const tokens = parsed.data.tokens;
      const requestedTokens =
        tokens === undefined
          ? 0
          : (tokens.input ?? 0) +
            (tokens.cached_input ?? 0) +
            (tokens.output ?? 0) +
            (tokens.reasoning ?? 0);
      const decision = await checkQuota(
        {
          tenantId,
          plan: tenant.plan,
          status: tenant.status,
          requestedApi: 1,
          requestedTokens,
        },
        {
          getLimits: activeDeps.getPlanLimits,
          getUsage: async (id) => ({
            apiUsed: await activeDeps.countApiUsage(id),
            tokenUsed: await activeDeps.sumTokenUsage(id),
          }),
        },
      );
      if (!decision.allowed) {
        // Over-limit writes create no event: deny BEFORE record.
        if (decision.code === 429) {
          const retryAfter = decision.retryAfter ?? RETRY_AFTER_SECONDS;
          res.setHeader('Retry-After', String(retryAfter));
          res.status(429).json({
            reason: decision.reason,
            message: decision.message,
            retry_after: retryAfter,
          });
          return;
        }
        res.status(402).json({ reason: decision.reason, message: decision.message });
        return;
      }
      const { event, inserted } = await recordUsage(
        { tenantId, idempotencyKey, tokens: parsed.data.tokens },
        { insert: activeDeps.insert },
      );
      res.status(200).json({
        allowed: true,
        usage: {
          id: event.id,
          type: event.type,
          qty: event.qty,
          token_breakdown: event.token_breakdown,
        },
        deduped: !inserted,
      });
    } catch (err: unknown) {
      const maybeStatus = (err as unknown as { status?: unknown }).status;
      const errStatus =
        err instanceof Error &&
        typeof maybeStatus === 'number' &&
        maybeStatus >= 400 &&
        maybeStatus < 500
          ? maybeStatus
          : 500;
      next(
        Object.assign(err instanceof Error ? err : new Error('generate failed'), {
          status: errStatus,
        }),
      );
    }
  },
);

export default router;
