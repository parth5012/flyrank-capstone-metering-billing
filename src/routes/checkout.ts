// POST /checkout (P3-T2): create Stripe Checkout session for Pro subscription.
// Validates {tenant_id} via zod (4xx never 500). Checks tenant existence via
// findTenant (unknown -> 404). Enforces Stripe test mode (sk_test_ only, no real money).
// Passes mode: 'subscription', line_items Pro price, success/cancel URLs,
// client_reference_id = tenant_id, and metadata.tenant_id.
// Returns {checkout_url: session.url}. Secrets stay server-side.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import * as tenantRepo from '../repos/tenant';

const router = Router();

export const checkoutBodySchema = z.object({
  tenant_id: z.string({ required_error: 'tenant_id required' }).trim().min(1, 'tenant_id required'),
});

export interface CheckoutSessionResult {
  url: string | null;
  id?: string;
}

export interface CheckoutDeps {
  findTenant: typeof tenantRepo.findTenant;
  createSession: (params: Stripe.Checkout.SessionCreateParams) => Promise<CheckoutSessionResult>;
  getStripeSecretKey?: () => string | undefined;
  getProPriceId?: () => string | undefined;
  getBaseUrl?: () => string;
}

let stripeClient: Stripe | null = null;

function getProdStripe(secretKey: string): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(secretKey);
  }
  return stripeClient;
}

async function prodCreateSession(
  params: Stripe.Checkout.SessionCreateParams,
): Promise<CheckoutSessionResult> {
  const secretKey = activeDeps.getStripeSecretKey
    ? activeDeps.getStripeSecretKey()
    : process.env.STRIPE_SECRET_KEY;
  if (!secretKey || !secretKey.startsWith('sk_test_')) {
    throw Object.assign(
      new Error('STRIPE_SECRET_KEY missing or not in test mode (must start with sk_test_)'),
      { status: 500 },
    );
  }
  const stripe = getProdStripe(secretKey);
  const session = await stripe.checkout.sessions.create(params);
  return { url: session.url, id: session.id };
}

const prodDeps: CheckoutDeps = {
  findTenant: tenantRepo.findTenant,
  createSession: prodCreateSession,
  getStripeSecretKey: () => process.env.STRIPE_SECRET_KEY,
  getProPriceId: () => process.env.STRIPE_PRO_PRICE_ID,
  getBaseUrl: () => process.env.APP_BASE_URL || 'http://localhost:3000',
};

let activeDeps: CheckoutDeps = prodDeps;

export function setCheckoutDeps(deps: Partial<CheckoutDeps> | null): void {
  activeDeps = deps ? { ...activeDeps, ...deps } : prodDeps;
}

router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = checkoutBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'validation_failed',
        message: 'tenant_id required',
        details: parsed.error.flatten(),
      });
      return;
    }

    const { tenant_id: tenantId } = parsed.data;

    let tenant: tenantRepo.Tenant | null;
    try {
      tenant = await activeDeps.findTenant(tenantId);
    } catch (err: unknown) {
      next(
        Object.assign(err instanceof Error ? err : new Error('database error'), {
          status: 500,
        }),
      );
      return;
    }

    if (!tenant) {
      res.status(404).json({
        error: 'unknown_tenant',
        message: `unknown tenant: ${tenantId}`,
      });
      return;
    }

    // Test-mode validation: live keys (sk_live_...) are strictly forbidden per AGENTS.md
    const getSecretKey = activeDeps.getStripeSecretKey ?? (() => process.env.STRIPE_SECRET_KEY);
    const secretKey = getSecretKey();
    if (secretKey !== undefined && !secretKey.startsWith('sk_test_')) {
      res.status(500).json({
        error: 'configuration_error',
        message: 'STRIPE_SECRET_KEY must be in test mode (must start with sk_test_)',
      });
      return;
    }

    if (activeDeps.createSession === prodCreateSession) {
      if (!secretKey) {
        res.status(500).json({
          error: 'configuration_error',
          message: 'STRIPE_SECRET_KEY missing or not in test mode (must start with sk_test_)',
        });
        return;
      }
    }

    const getPriceId = activeDeps.getProPriceId ?? (() => process.env.STRIPE_PRO_PRICE_ID);
    const proPriceId = getPriceId();
    if (!proPriceId) {
      res.status(500).json({
        error: 'configuration_error',
        message: 'STRIPE_PRO_PRICE_ID missing',
      });
      return;
    }

    const getBaseUrl =
      activeDeps.getBaseUrl ?? (() => process.env.APP_BASE_URL || 'http://localhost:3000');
    const baseUrl = getBaseUrl().replace(/\/+$/, '');

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      line_items: [
        {
          price: proPriceId,
          quantity: 1,
        },
      ],
      success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/checkout/cancel`,
      client_reference_id: tenant.id,
      metadata: {
        tenant_id: tenant.id,
      },
    };

    if (tenant.stripe_customer_id) {
      sessionParams.customer = tenant.stripe_customer_id;
    }

    const session = await activeDeps.createSession(sessionParams);
    if (!session || !session.url) {
      res.status(500).json({
        error: 'checkout_session_failed',
        message: 'failed to generate checkout url',
      });
      return;
    }

    res.status(200).json({
      checkout_url: session.url,
    });
  } catch (err: unknown) {
    const maybeStatus = (err as unknown as { status?: unknown }).status;
    const errStatus =
      err instanceof Error &&
      typeof maybeStatus === 'number' &&
      maybeStatus >= 400 &&
      maybeStatus < 500
        ? maybeStatus
        : 500;
    next(
      Object.assign(err instanceof Error ? err : new Error('checkout failed'), {
        status: errStatus,
      }),
    );
  }
});

export default router;
