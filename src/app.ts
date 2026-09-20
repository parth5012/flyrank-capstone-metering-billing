// Express app factory - scaffold only. Mounts /health; phase routes TODO.
import express, { type Express, type Request, type Response, type NextFunction } from 'express';

interface HttpError extends Error {
  status?: number;
}

export function createApp(): Express {
  const app = express();

  app.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));

  // Phase 2: app.use('/generate', require('./routes/generate'));
  // Phase 2: app.use('/usage', require('./routes/usage'));
  // Phase 3: app.use('/checkout', require('./routes/checkout'));
  // Phase 3: app.use('/webhooks/stripe', require('./routes/webhooks'));

  app.use((err: HttpError, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message || 'internal_error' });
  });

  return app;
}
