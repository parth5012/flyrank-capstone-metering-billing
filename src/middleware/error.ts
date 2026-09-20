// Central error mapper (P2-T2): validation -> 4xx, never 500 from /generate.
// Coerces accidental 500s on /generate to 503; always JSON {error,message}.
import type { Request, Response, NextFunction } from 'express';

interface HttpError extends Error {
  status?: number;
  details?: unknown;
}

export function errorMiddleware(
  err: HttpError,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let status = err.status ?? 501;
  const isGenerate = (req.originalUrl ?? req.url ?? '').startsWith('/generate');
  if (isGenerate && status === 500) status = 503;
  const message = err.message || 'not_implemented';
  res.status(status).json({ error: message, message });
}
