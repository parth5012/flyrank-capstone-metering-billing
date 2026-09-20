# Design Doc - Usage Metering & Billing Engine (Phase 1 Gate)

> Stack assumption: Node.js + Express + Postgres via Docker + Stripe test mode.
> If you prefer Python + FastAPI, swap layer names 1:1 - schema and contracts below stay identical.

## 1. Problem
Every SaaS must answer: how much used? what cost? over limit? Bugs here = double-charge or unlimited free access. Build a small, correct service for 2 plans x 2 usage types x 1 billable endpoint, with Stripe as payment truth.

## 2. Data model (Postgres, migrations, tenant-isolated)
- `tenants(id PK, name, plan ENUM('free','pro'), stripe_customer_id UNIQUE NULL, status, created_at)`
- `plans(id PK, name UNIQUE, api_limit INT, token_limit BIGINT, price_cents INT)` - seed: Free(1000, 100000, 0), Pro(100000, 10000000, 2000)
- `subscriptions(id PK, tenant_id FK, stripe_subscription_id UNIQUE, status, current_period_end, created_at)`
- `usage_events(id PK, tenant_id FK, type ENUM('api_call','ai_token'), qty INT, idempotency_key VARCHAR UNIQUE, token_breakdown JSONB NULL {input, cached_input, output, reasoning}, created_at, INDEX(tenant_id, created_at))`
- `stripe_events(event_id PK, type, processed_at)` - webhook dedup table.
- Money: integers only (cents / micro-cents). Never FLOAT.
- Isolation: every query filters `tenant_id`. No cross-tenant reads.

## 3. API surface
- `POST /generate` Headers: `X-Tenant-Id, Idempotency-Key (required, uuidv4)` Body: `{ tokens?: {input, cached_input, output, reasoning} }` -> `200 {allowed:true, usage:{used,limit}, cost_cents}` or `429 {reason: quota_exceeded, retry_after}` / `402 {reason: upgrade_required}` / `4xx` on validation, never 500.
- `GET /usage?tenant_id=` -> `{ tenant, plan, api:{used,limit}, tokens:{used,limit}, cost_cents, period }`
- `POST /checkout` Body: `{tenant_id}` -> `{checkout_url}` (Stripe Checkout, Pro price)
- `POST /webhooks/stripe` - raw body, verify `stripe-signature` vs `whsec_`, check `stripe_events`, apply `checkout.session.completed / customer.subscription.updated|deleted` -> update `tenants.plan/status + subscriptions`.

## 4. Layer sketch
`HTTP (Express routers + zod validation) -> Services (MeterService.record, QuotaService.check, CostService.rollup, BillingService.sync) -> Repos (pg) -> Postgres`
Background job (separate from request path, retries + alert log): nightly `reconciliation` (DB vs Stripe list) + `usage-alerts` at 80%/100%. Proves shared requirement #3.

## 5. Idempotency strategy (heart of capstone)
DB `UNIQUE(idempotency_key)`. Flow: `INSERT usage_events ... ON CONFLICT DO NOTHING RETURNING` - conflict = return original stored result, no new event, no cost change. Same for Stripe: `INSERT stripe_events(event_id) ON CONFLICT DO NOTHING` - replay = ignored. Proof for EVIDENCE: send same curl twice, show 1 row in DB.

## 6. Quota + cost rules
Check `current + requested > limit` before write. At 999/1000 allow, at 1000 allow per documented rule (last allowed), 1001 -> 429. Cost in `config/pricing.js`: `INPUT=0.15c/1k, CACHED=0.0375c/1k, OUTPUT=0.6c/1k, reasoning billed as output`. Rollup sums per category, never adds raw tokens.

## 7. Explicit non-goal
No invoicing, proration, or overage billing in core. Simulated tokens only, no LLM call. Stripe test mode only, secrets in `.env`.
