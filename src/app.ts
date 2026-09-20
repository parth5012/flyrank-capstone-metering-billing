// Express app factory (P2-T1 wiring): layered HTTP -> Services -> Repos -> Postgres.
// Routers are mounted but still phase stubs (501) — P2-T2..T6 fill them in.
// Stripe webhooks mount BEFORE express.json() to keep the raw body for
// signature verification (DESIGN.md §3).
import express, { type Express, type Request, type Response } from 'express';
import { errorMiddleware } from './middleware/error';
import generateRouter from './routes/generate';
import usageRouter from './routes/usage';
import checkoutRouter from './routes/checkout';
import webhooksRouter from './routes/webhooks';

export function createApp(): Express {
  const app = express();

  app.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));

  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }), webhooksRouter);

  app.use(express.json());

  app.use('/generate', generateRouter);
  app.use('/usage', usageRouter);
  app.use('/checkout', checkoutRouter);

  app.use((_req: Request, res: Response) => res.status(404).json({ error: 'not_found' }));

  app.use(errorMiddleware);

  return app;
}
