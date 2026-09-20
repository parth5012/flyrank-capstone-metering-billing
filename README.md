# Usage Metering & Billing Engine

Backend service answering: how much used? what cost? over limit? Idempotent metering, quota enforcement (`429`/`402`), token-aware cost math, Stripe test-mode sync.

## Architecture
```
Client -> POST /generate -> MeterService.record(tenant,type,qty,key)
  duplicate key? -> return original (no new event)
  -> store usage_event -> Quota Check -> allow / 429,402
GET /usage <- rollup(usage_events) -> {used, limit, cost}
Stripe Checkout -> subscription
Stripe --signed--> POST /webhooks/stripe -> verify -> dedup -> update plan
```

## Run + Seed (clean machine)
1. `cp .env.example .env` - fill `sk_test_...`, `whsec_...`
2. `docker compose up --build`
3. `npm run seed` - creates Free/Pro plans + demo tenant
4. `stripe listen --forward-to localhost:3000/webhooks/stripe`
5. Test: `curl -H "X-Tenant-Id: demo-tenant" -H "Idempotency-Key: $(uuidgen)" localhost:3000/usage`

Plans: Free `1000 API / 100k tokens`, Pro `100000 API / 10M tokens / $20`. See `DESIGN.md`.

## Limitations (honest)
- Simulated tokens, no LLM call. No invoicing/proration/overage in core.
- Single-instance, no sharding. Rollups per-request, no cache.
- Test mode only, no real money.
