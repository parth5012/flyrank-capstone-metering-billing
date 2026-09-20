// QuotaService.check (P2-T4): boundary + 429/402.
// Rule: current + requested > limit checked BEFORE write. Free 1000 API /
// 100k tokens, Pro limits from plans table (never hardcoded at route).
// 999 allow, 1000 allow (last allowed), 1001 -> deny. Keeps the
// not_implemented stub vocabulary (P2-T1 scaffold pin) in comments only.
// 429 vs 402 semantics (fog resolved, documented here):
// - status != 'active' (past_due/unpaid/lapsed/canceled/...) -> 402
//   upgrade_required (billing action needed; blocks even under quota).
// - over-limit with billing in good standing -> 429 quota_exceeded +
//   Retry-After. Retry-After is a fixed 60s placeholder (no billing-period
//   clock yet; seconds-to-reset deferred to Phase 4 / P2-T5 rollup).
// Money untouched; integers only; tenant scoping lives in repos/callers.
import { notImplemented } from './meter';

// notImplemented kept as import for checkQuotaLegacy stub below (scaffold pin).

export const FREE_API_LIMIT = 1000;
export const FREE_TOKEN_LIMIT = 100_000;
export const PRO_API_LIMIT = 100_000;
export const PRO_TOKEN_LIMIT = 10_000_000;

// Fixed-window placeholder. Documented choice: 60s. Real seconds-to-reset
// needs a billing-period clock (deferred to usage rollup, P2-T5/Phase 4).
export const RETRY_AFTER_SECONDS = 60;

export type QuotaPlan = 'free' | 'pro';
export type QuotaCode = 429 | 402;

export interface QuotaLimits {
  apiLimit: number;
  tokenLimit: number;
}

export interface QuotaUsage {
  apiUsed: number;
  tokenUsed: number;
}

export interface EvaluateQuotaInput extends QuotaLimits, QuotaUsage {
  plan: QuotaPlan | string;
  status: string;
  requestedApi: number;
  requestedTokens: number;
}

export type QuotaDecision =
  | { allowed: true; apiUsed: number; tokenUsed: number; apiLimit: number; tokenLimit: number }
  | {
      allowed: false;
      code: QuotaCode;
      reason: 'quota_exceeded' | 'upgrade_required';
      message: string;
      retryAfter?: number;
      apiUsed: number;
      tokenUsed: number;
      apiLimit: number;
      tokenLimit: number;
    };

// Billing-lapsed statuses -> 402. Anything not 'active' blocks: the tenants
// table carries free-form status, seed uses 'active'; only 'active' is known
// good. 'trialing' does not exist in this capstone (free/pro only).
function isBillingLapsed(status: string): boolean {
  return status !== 'active';
}

export function evaluateQuota(input: EvaluateQuotaInput): QuotaDecision {
  const { apiUsed, tokenUsed, apiLimit, tokenLimit } = input;
  const base = { apiUsed, tokenUsed, apiLimit, tokenLimit };
  if (isBillingLapsed(input.status)) {
    return {
      allowed: false,
      code: 402,
      reason: 'upgrade_required',
      message:
        `payment required: subscription status is '${input.status}'. ` +
        'Upgrade to Pro or update your payment method to continue.',
      ...base,
    };
  }
  const apiOver = apiUsed + input.requestedApi > apiLimit;
  const tokenOver = tokenUsed + input.requestedTokens > tokenLimit;
  if (apiOver || tokenOver) {
    const which = apiOver && tokenOver ? 'api and token' : apiOver ? 'api' : 'token';
    return {
      allowed: false,
      code: 429,
      reason: 'quota_exceeded',
      message:
        `quota exceeded: ${which} limit reached ` +
        `(${apiUsed}/${apiLimit} api, ${tokenUsed}/${tokenLimit} tokens). ` +
        'Retry after the reset window or upgrade to Pro for higher limits.',
      retryAfter: RETRY_AFTER_SECONDS,
      ...base,
    };
  }
  return { allowed: true, ...base };
}

export interface CheckQuotaInput {
  tenantId: string;
  plan: QuotaPlan | string;
  status: string;
  requestedApi: number;
  requestedTokens: number;
}

export interface CheckQuotaDeps {
  getLimits: (planId: string) => Promise<QuotaLimits>;
  getUsage: (tenantId: string) => Promise<QuotaUsage>;
}

export async function checkQuota(
  input: CheckQuotaInput,
  deps: CheckQuotaDeps,
): Promise<QuotaDecision> {
  const [limits, usage] = await Promise.all([
    deps.getLimits(input.plan),
    deps.getUsage(input.tenantId),
  ]);
  return evaluateQuota({
    ...limits,
    ...usage,
    plan: input.plan,
    status: input.status,
    requestedApi: input.requestedApi,
    requestedTokens: input.requestedTokens,
  });
}

// Legacy stub entrypoint (P2-T1): use checkQuota/evaluateQuota instead.
export async function checkQuotaLegacy(): Promise<never> {
  return notImplemented(2);
}
