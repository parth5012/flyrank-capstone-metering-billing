// GET /usage - TODO Phase 4 (cost rollup). Stub only.
import { Router, type Request, type Response } from 'express';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.status(501).json({ error: 'not_implemented', phase: 4 });
});

export default router;
