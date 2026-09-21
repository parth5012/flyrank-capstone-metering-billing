# Usage Metering & Billing Engine

Backend service answering: how much used? what cost? over limit? Idempotent metering, quota enforcement (`429`/`402`), token-aware cost math, Stripe test-mode sync.

## Architecture
```
Client -> POST /generate -> MeterService.record(tenant,type,qty,key)
  duplicate key? -> return original (no new event)
  -> Quota Check -> allow: store usage_event -> 200 / deny: 429,402
GET /usage <- rollup(usage_events) -> {used, limit, cost}
Stripe Checkout -> subscription
Stripe --signed--> POST /webhooks/stripe -> verify -> dedup -> update plan
```

## Run + Seed (clean machine — stranger-can-run)

Prereqs: Docker, Node 20+, `uuidgen`. Stripe CLI only needed for live webhook replay.

```bash
cp .env.example .env   # fill sk_test_... / whsec_... (test mode only, never commit)
docker compose up --build -d
npm run seed           # creates Free/Pro plans + demo-tenant (idempotent, re-runnable)
```

Smoke (copy-paste; `Idempotency-Key` must be uuidv4 or the server returns 400):

```bash
KEY=$(uuidgen)
curl -s -X POST localhost:3000/generate \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: demo-tenant" -H "Idempotency-Key: $KEY" \
  -d '{"tokens":{"input":10,"output":5}}'
# expect: 200 {"allowed":true,"usage":{...},"deduped":false}

curl -s localhost:3000/usage -H "X-Tenant-Id: demo-tenant"
# expect: 200 {"tenant":"demo-tenant","plan":"free","api":{"used":1,"limit":1000},
#   "tokens":{"used":15,"limit":100000},"cost_cents":0,"period":{...}}
# (15 tiny tokens round to 0c — cost floors per rollup; see EVIDENCE Probe 5
# for a 705c mixed-breakdown example.)
```

Quota boundary: at 1000/1000 the request still returns 200; the 1001st returns
`429 {"reason":"quota_exceeded",...}` + `Retry-After: 60` (lapsed `past_due`
tenant returns `402 {"reason":"upgrade_required"}` instead).

Live Stripe replay (needs `stripe login` first, test mode only).
The app reads `STRIPE_WEBHOOK_SECRET` from the environment (`.env` is NOT
baked into the image, compose passes it through), so the signing secret must
be in place before the app boots:

```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
# 1. copy the whsec_... value it prints into .env as STRIPE_WEBHOOK_SECRET
# 2. recreate the app so it picks up the secret:
docker compose up -d --force-recreate app
# 3. only then trigger:
stripe trigger checkout.session.completed \
  --add checkout_session:client_reference_id=demo-tenant
# expect: webhook 200 {"received":true,...}, tenant flips Free->Pro
```

Troubleshooting:
- `seed: failed — is Postgres up?` → run `docker compose up -d db` first, then `npm run seed`.
- `400 x-tenant-id required` → missing `X-Tenant-Id` header (usage reads the header, not `?tenant_id=`).
- `400 idempotency-key required` → `Idempotency-Key` must be uuidv4 (`uuidgen` output).
- `STRIPE_SECRET_KEY ... must start with sk_test_` → `.env` has no real key; test mode only.
- No Docker in this env → `npm test` (114 tests, ephemeral server, no DB) is the portable proof; see `EVIDENCE.md`.

Plans: Free `1000 API / 100k tokens`, Pro `100000 API / 10M tokens / $20`. See `DESIGN.md`.

## Limitations (honest)
- Simulated tokens, no LLM call. No invoicing/proration/overage in core.
- Single-instance, no sharding. Rollups per-request, no cache.
- Test mode only, no real money.
