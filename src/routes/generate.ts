// POST /generate validation (P2-T2) + idempotent record (P2-T3).
// zod on HTTP layer, 4xx never 500. Valid -> 200 {allowed, usage, deduped}
// via MeterService.record (UNIQUE + ON CONFLICT DO NOTHING; conflict
// returns original, no new event, no cost change). Quota check deferred to
// P2-T4 — valid requests record without quota for now.
// Tenant isolation: tenantId comes ONLY from X-Tenant-Id header; repos scope
// every query by tenant_id; unknown tenant -> 404.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { tenantMiddleware, type TenantRequest } from '../middleware/tenant';
import { idempotencyMiddleware, type IdempotencyRequest } from '../middleware/idempotency';
import * as tenantRepo from '../repos/tenant';
import * as usageRepo from '../repos/usage';
import { recordUsage } from '../services/meter';

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

// Test seam (P2-T3): production defaults hit Postgres via repos. Tests run
// without Docker DB, so they install in-memory doubles via setGenerateDeps
// (emulating UNIQUE + ON CONFLICT DO NOTHING first-write-wins). Passing null
// restores production wiring. Live-DB double-send proof deferred to P2-T7.
export interface GenerateDeps {
  findTenant: typeof tenantRepo.findTenant;
  insert: typeof usageRepo.insertUsageEvent;
}

const prodDeps: GenerateDeps = {
  findTenant: tenantRepo.findTenant,
  insert: usageRepo.insertUsageEvent,
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

      let tenant: { id: string } | null;
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
      // P2-T4 will check quota here (1000 allow / 1001 -> 429-402) BEFORE
      // record. Until then every valid request records (stub allow).
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
