// Resolves tenant from X-Tenant-Id (P2-T2 validation, HTTP layer only).
// zod at boundary: 400 if missing/empty; attaches req.tenantId; never 500.
// Existence (unknown -> 404) lives in src/routes/generate.ts via findTenant.
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

export const tenantIdSchema = z.string().trim().min(1, 'x-tenant-id required');

export interface TenantRequest extends Request {
  tenantId?: string;
}

export function tenantMiddleware(req: Request, _res: Response, next: NextFunction): void {
  try {
    const raw = req.headers['x-tenant-id'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const parsed = tenantIdSchema.safeParse(value);
    if (!parsed.success) {
      next(
        Object.assign(new Error('x-tenant-id required'), {
          status: 400,
          details: parsed.error.flatten(),
        }),
      );
      return;
    }
    (req as TenantRequest).tenantId = parsed.data;
    next();
  } catch (err: unknown) {
    next(
      Object.assign(err instanceof Error ? err : new Error('tenant validation failed'), {
        status: 400,
      }),
    );
  }
}
