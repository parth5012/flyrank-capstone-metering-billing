// POST /checkout - TODO Phase 3 (Stripe test mode). Stub only.
import { Router, type Request, type Response } from 'express';

const router = Router();

router.post('/', (_req: Request, res: Response) => {
  res.status(501).json({ error: 'not_implemented', phase: 3 });
});

export default router;
