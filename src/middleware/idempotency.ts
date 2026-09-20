// Requires Idempotency-Key header - TODO Phase 2.
import type { Request, Response, NextFunction } from 'express';

export function idempotencyMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  next(Object.assign(new Error('not_implemented'), { phase: 2, status: 501 }));
}
