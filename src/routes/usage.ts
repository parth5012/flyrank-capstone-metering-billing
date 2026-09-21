// GET /usage rollup (P2-T5): tenant-isolated read of usage_events.
// Shape (DESIGN.md §3): {tenant,plan,api:{used,limit},tokens:{used,limit},
// cost_cents,period}. api used = COUNT(*) tenant-scoped, tokens used =
// SUM(qty) over ai_token. cost_cents = rollupCost over per-category
// breakdown sums (P4-T2, integers only; 0 when the dep is absent in old
// doubles). period = current UTC calendar-month window; subscription
// current_period_end wiring deferred to Phase 4. Unknown tenant -> 404,
// missing header -> 400 via tenantMiddleware. Never 500 from validation.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { tenantMiddleware, type TenantRequest } from '../middleware/tenant';
import * as tenantRepo from '../repos/tenant';
import * as usageRepo from '../repos/usage';
import { rollupCost } from '../services/cost';

const router = Router();

export interface UsageDeps {
  findTenant: typeof tenantRepo.findTenant;
  countApiUsage: typeof usageRepo.countUsageByTenant;
  sumTokenUsage: typeof usageRepo.sumTokensByTenant;
  sumTokenBreakdowns?: typeof usageRepo.sumTokenBreakdownsByTenant;
  getPlanLimits: (planId: string) => Promise<{ apiLimit: number; tokenLimit: number }>;
}

async function prodGetPlanLimits(
  planId: string,
): Promise<{ apiLimit: number; tokenLimit: number }> {
  const plan = await tenantRepo.findPlan(planId);
  if (!plan) throw Object.assign(new Error(`unknown plan: ${planId}`), { status: 500 });
  return { apiLimit: plan.api_limit, tokenLimit: Number(plan.token_limit) };
}

const prodDeps: UsageDeps = {
  findTenant: tenantRepo.findTenant,
  countApiUsage: usageRepo.countUsageByTenant,
  sumTokenUsage: usageRepo.sumTokensByTenant,
  sumTokenBreakdowns: usageRepo.sumTokenBreakdownsByTenant,
  getPlanLimits: prodGetPlanLimits,
};

let activeDeps: UsageDeps = prodDeps;

// Test seam (mirrors setGenerateDeps): no-DB tests install in-memory
// doubles; null restores production Postgres wiring.
export function setUsageDeps(deps: UsageDeps | null): void {
  activeDeps = deps ?? prodDeps;
}

// Current UTC calendar-month window. Placeholder until Phase 4 wires
// subscriptions.current_period_end; shape {start,end} stays stable.
export function currentPeriod(now: Date = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

router.get(
  '/',
  tenantMiddleware,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const tenantId = (req as TenantRequest).tenantId as string;
      const tenant = await activeDeps.findTenant(tenantId);
      if (!tenant) {
        res
          .status(404)
          .json({ error: 'unknown_tenant', message: `unknown tenant: ${tenantId}` });
        return;
      }
      const limits = await activeDeps.getPlanLimits(tenant.plan);
      const [apiUsed, tokenUsed] = await Promise.all([
        activeDeps.countApiUsage(tenantId),
        activeDeps.sumTokenUsage(tenantId),
      ]);
      // P4-T2: cost from per-category breakdown sums (tenant-scoped), single
      // floor inside rollupCost. Doubles without the dep keep the 0
      // placeholder; shape stays {tenant,plan,api,tokens,cost_cents,period}.
      let costCents = 0;
      if (activeDeps.sumTokenBreakdowns) {
        const breakdown = await activeDeps.sumTokenBreakdowns(tenantId);
        costCents = rollupCost([breakdown]);
      }
      res.status(200).json({
        tenant: tenantId,
        plan: tenant.plan,
        api: { used: apiUsed, limit: limits.apiLimit },
        tokens: { used: tokenUsed, limit: limits.tokenLimit },
        cost_cents: costCents,
        period: currentPeriod(),
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
        Object.assign(err instanceof Error ? err : new Error('usage failed'), {
          status: errStatus,
        }),
      );
    }
  },
);

export default router;
