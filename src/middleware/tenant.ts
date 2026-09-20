// Resolves tenant from X-Tenant-Id - TODO Phase 2 (zod at boundary).
import type { Request, Response, NextFunction } from 'express';

export function tenantMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  next(Object.assign(new Error('not_implemented'), { phase: 2, status: 501 }));
}
