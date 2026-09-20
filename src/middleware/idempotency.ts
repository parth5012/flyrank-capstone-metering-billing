// Requires Idempotency-Key uuidv4 (P2-T2 validation, HTTP layer only).
// zod at boundary: 400 if missing/invalid; attaches req.idempotencyKey; never 500.
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

export const idempotencyKeySchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'idempotency-key must be uuidv4',
  );

export interface IdempotencyRequest extends Request {
  idempotencyKey?: string;
}

export function idempotencyMiddleware(req: Request, _res: Response, next: NextFunction): void {
  try {
    const raw = req.headers['idempotency-key'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const parsed = idempotencyKeySchema.safeParse(value);
    if (!parsed.success) {
      next(
        Object.assign(new Error('idempotency-key must be uuidv4'), {
          status: 400,
          details: parsed.error.flatten(),
        }),
      );
      return;
    }
    (req as IdempotencyRequest).idempotencyKey = parsed.data;
    next();
  } catch (err: unknown) {
    next(
      Object.assign(err instanceof Error ? err : new Error('idempotency validation failed'), {
        status: 400,
      }),
    );
  }
}
