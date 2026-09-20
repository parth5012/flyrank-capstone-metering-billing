// Central error mapper - TODO Phase 2. Validation -> 4xx, never 500 from /generate.
import type { Request, Response, NextFunction } from 'express';

interface HttpError extends Error {
  status?: number;
}

export function errorMiddleware(
  err: HttpError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status = err.status ?? 501;
  res.status(status).json({ error: err.message || 'not_implemented' });
}
