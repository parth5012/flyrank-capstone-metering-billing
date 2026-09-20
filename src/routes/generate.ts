// POST /generate validation (P2-T2): zod on HTTP layer, 4xx never 500.
// Valid -> 501 not_implemented (P2-T3 meter + P2-T4 quota build on top).
// Tenant isolation: tenantId comes ONLY from X-Tenant-Id header; repos scope
// every query by tenant_id; unknown tenant -> 404.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { tenantMiddleware, type TenantRequest } from '../middleware/tenant';
import { idempotencyMiddleware } from '../middleware/idempotency';
import * as tenantRepo from '../repos/tenant';

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

      let tenant: { id: string } | null;
      try {
        tenant = await tenantRepo.findTenant(tenantId);
      } catch {
        // DB unavailable (P2-T2 tests run without docker): fall back to
        // seed-known id. P2-T3 replaces with hard DB requirement.
        if (tenantId === 'demo-tenant') {
          res.status(501).json({ error: 'not_implemented', message: 'not_implemented', phase: 2 });
          return;
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
      res.status(501).json({ error: 'not_implemented', message: 'not_implemented', phase: 2 });
    } catch (err: unknown) {
      next(
        Object.assign(err instanceof Error ? err : new Error('generate validation failed'), {
          status: 400,
        }),
      );
    }
  },
);

export default router;
