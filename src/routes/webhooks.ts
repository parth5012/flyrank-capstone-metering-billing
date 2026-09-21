// POST /webhooks/stripe (P3-T3 & P3-T4): Stripe webhook signature verification + billing sync.
// Uses raw body (express.raw mounted in src/app.ts:17 before express.json).
// Verifies stripe-signature header against STRIPE_WEBHOOK_SECRET (whsec_).
// Forged / invalid / missing signature -> 400 (Probe 4a). No DB writes before verify.
// Dedup via stripe_events (idempotent replay -> 200 deduped: true).
// Syncs plans/subscriptions via BillingService.applyStripeEvent.
import { Router, type Request, type Response, type NextFunction } from 'express';
import Stripe from 'stripe';
import * as stripeEventRepo from '../repos/stripeEvent';
import * as billingService from '../services/billing';

const router = Router();

export interface WebhookDeps {
  constructEvent: (
    payload: string | Buffer,
    header: string | Buffer | Array<string>,
    secret: string,
  ) => Stripe.Event;
  getWebhookSecret?: () => string | undefined;
  markProcessed?: typeof stripeEventRepo.markProcessed;
  removeProcessed?: typeof stripeEventRepo.removeProcessed;
  applyStripeEvent?: (event: billingService.StripeEventLike) => Promise<unknown>;
}

const prodDeps: WebhookDeps = {
  constructEvent: (payload, header, secret) =>
    Stripe.webhooks.constructEvent(payload, header, secret),
  getWebhookSecret: () => process.env.STRIPE_WEBHOOK_SECRET,
  markProcessed: stripeEventRepo.markProcessed,
  removeProcessed: stripeEventRepo.removeProcessed,
  applyStripeEvent: billingService.applyStripeEvent,
};

let activeDeps: WebhookDeps = prodDeps;

export function setWebhookDeps(deps: Partial<WebhookDeps> | null): void {
  activeDeps = deps ? { ...activeDeps, ...deps } : prodDeps;
}

router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // 1. Raw body validation: req.body MUST be a Buffer; if object, raw middleware didn't run.
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({
        error: 'invalid_payload',
        message: 'raw buffer body required',
      });
      return;
    }

    // 2. Signature header validation: must be present and non-empty string.
    const sig = req.headers['stripe-signature'];
    if (!sig || typeof sig !== 'string' || sig.trim() === '') {
      res.status(400).json({
        error: 'missing_signature',
        message: 'stripe-signature header required',
      });
      return;
    }

    // 3. Webhook secret from configuration/seam.
    const getSecret = activeDeps.getWebhookSecret ?? (() => process.env.STRIPE_WEBHOOK_SECRET);
    const webhookSecret = getSecret();
    if (!webhookSecret) {
      res.status(500).json({
        error: 'configuration_error',
        message: 'STRIPE_WEBHOOK_SECRET missing',
      });
      return;
    }

    // 4. Verify signature via constructEvent. Any verification failure -> 400.
    // Catch StripeSignatureVerificationError or any verify throw; no DB writes before verify.
    let event: Stripe.Event;
    try {
      event = activeDeps.constructEvent(req.body, sig, webhookSecret);
    } catch (err: unknown) {
      res.status(400).json({
        error: 'bad_signature',
        message: err instanceof Error ? err.message : 'signature verification failed',
      });
      return;
    }

    // 5. Dedup via stripe_events. First write returns true; replay returns false.
    const markProcessed = activeDeps.markProcessed ?? stripeEventRepo.markProcessed;
    const first = await markProcessed(event.id, event.type);
    if (!first) {
      res.status(200).json({
        received: true,
        deduped: true,
        id: event.id,
        event_id: event.id,
        type: event.type,
      });
      return;
    }

    // 6. Apply billing event (e.g. checkout.session.completed -> Pro plan).
    // On apply failure roll back the dedup record so Stripe retry re-applies.
    try {
      const apply = activeDeps.applyStripeEvent ?? billingService.applyStripeEvent;
      await apply(event as unknown as billingService.StripeEventLike);
    } catch (err: unknown) {
      try {
        const remove = activeDeps.removeProcessed ?? stripeEventRepo.removeProcessed;
        await remove(event.id);
      } catch {
        // ignore secondary error — primary apply error takes precedence
      }
      const applyError = err instanceof Error ? err : new Error(String(err));
      if (!('status' in applyError)) {
        Object.assign(applyError, { status: 500 });
      }
      next(applyError);
      return;
    }

    // 7. Acknowledge event on success.
    res.status(200).json({
      received: true,
      id: event.id,
      event_id: event.id,
      type: event.type,
    });
  } catch (err: unknown) {
    next(err);
  }
});

export default router;
