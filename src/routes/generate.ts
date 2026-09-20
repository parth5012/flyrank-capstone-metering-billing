// POST /generate - TODO Phase 2 (metering + quota). Stub only.
import { Router, type Request, type Response } from 'express';

const router = Router();

router.post('/', (_req: Request, res: Response) => {
  res.status(501).json({ error: 'not_implemented', phase: 2 });
});

export default router;
