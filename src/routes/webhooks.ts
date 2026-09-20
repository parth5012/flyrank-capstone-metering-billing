// POST /webhooks/stripe - TODO Phase 3 (verify + dedup). Stub only.
// Must use raw body + stripe-signature vs whsec_ when implemented.
import { Router, type Request, type Response } from 'express';

const router = Router();

router.post('/', (_req: Request, res: Response) => {
  res.status(501).json({ error: 'not_implemented', phase: 3 });
});

export default router;
