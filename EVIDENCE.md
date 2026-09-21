# EVIDENCE.md - one proof per Section 6 checkbox

> Claims without pasted proof score as not done. Fill as you build.

## Metering
- [x] Double-send same Idempotency-Key -> 1 row. Proof: ephemeral-server transcript (test seam, no Docker DB in agent env) + `npm test` 54 pass. Live Postgres `SELECT COUNT(*)` deferred to review-gate DB env — exact commands below.

## Quotas
- [x] Boundary 1000/1000 allows, 1001 -> 429/402 with message. Proof: ephemeral-server transcript below (seeded 999 -> 1000th 200, 1001st 429 `quota_exceeded` + `Retry-After: 60`, count unchanged). 402 `upgrade_required` covered by unit/HTTP tests (past_due tenant). Live-DB boundary curl deferred to review-gate DB env.

## Cost
- [x] Pricing constants in `src/config/pricing.ts` + cached/reasoning math correct. Proof: constants (`TOKENS_PER_UNIT=1_000_000`, `INPUT_PER_M_CENTS=1500`, `CACHED_PER_M_CENTS=375`, `OUTPUT_PER_M_CENTS=6000`) + `tests/cost.test.ts` 12/12 green (cached 1M→375c = 1/4 input 1500c; reasoning 1M→6000c = output rate; mixed 100k/200k/50k/30k→705c; 1B-input integer-safe 1_500_000c; period additive `[a,b]==[combined]`). Suite tail: `ℹ tests 12 / ℹ pass 12 / ℹ fail 0`.
- [x] GET /usage matches constants. Proof: Probe 5 transcript below (mixed write → `GET /usage #1 {"cost_cents":705,...}` = `rollupCost` 705c; `#2` identical `stable=true`; tenant isolation `demo 1500c / other 0c`) + integration tests (`mixed write -> GET /usage cost_cents 705 matches rollup`, `tenant isolation`, `reads stable`) green in full `npm test` 114/114.

## Stripe
- [x] Test Checkout Free->Pro via webhook. Proof: Probe 3 ephemeral transcript below (POST /checkout -> SDK-signed `checkout.session.completed` -> tenant Free->Pro -> GET /usage Pro limits) + `tests/checkout.test.ts` (happy path `checkout_url`, session params) + `tests/billing-sync.test.ts` (`completed flips free->pro`). Live `stripe trigger` deferred to Stripe-enabled env — exact commands below.
- [x] Bad signature -> 400, replay -> once. Proof: Probe 4a/4b transcripts below (missing/forged -> 400 with zero `stripe_events` writes; replay same event twice -> first applies, second `200 deduped:true`, `COUNT 1`, apply once) + `tests/webhooks.test.ts` (replay `deduped:true` apply once) + `tests/billing-sync.test.ts` (Free→Pro flip, replay one sub row). Live trigger + replay deferred — exact commands below.

## Data/docs
- [x] Migrations present, tenant isolation. Proof: `db/migrations/001_init.sql` (`idempotency_key TEXT UNIQUE NOT NULL`, `stripe_events(event_id PK)`, `idx_usage_tenant_created`) + `tests/scaffold.test.ts` migration test green in `npm test` 114/114; every query in `src/repos/usage.ts` filters `tenant_id` (`WHERE tenant_id = $1`, cross-tenant key → 409); isolation covered by `tests/cost.test.ts` (`demo 1500c / other 0c`) + `tests/usage.test.ts` (cross-tenant key invisible).
- [x] README + diagram + capstone.yaml present. Proof: `README.md` (what/diagram ascii/run+seed stranger-can-run/limitations), `capstone.yaml` (`run: docker compose up --build`, `seed: npm run seed`, `test: npm test`, `base_url: http://localhost:3000`, 4 endpoints), `.env.example` (placeholders only, no secrets), `docs/architecture.md` + `BUILDLOG.md` Phase 4 entries; required-files `ls` all OK (see pack checklist).

---

## Probe 1 — Idempotency double-send (P2-T7, 2026-09-21)

Env: agent has no Docker/Postgres, so proof runs the real Express app
(`createApp` + `POST /generate`) on an ephemeral port with the same
in-memory test seam used by `tests/idempotency.test.ts` (first-write-wins
per `idempotency_key`, mirroring `UNIQUE(idempotency_key)` +
`ON CONFLICT DO NOTHING` in `src/repos/usage.ts`). Temp script lived only
in `/tmp/probe-transcript.ts` (not committed).

```text
=== PROBE 1: double-send same Idempotency-Key ===
KEY=a06aeb8b-74f9-41fd-9a61-396d3a621b7b

$ send #1: curl -s -i -X POST http://127.0.0.1:44073/generate \
    -H "Content-Type: application/json" \
    -H "X-Tenant-Id: demo-tenant" \
    -H "Idempotency-Key: a06aeb8b-74f9-41fd-9a61-396d3a621b7b" \
    -d '{"tokens":{"input":10,"output":5}}'
< HTTP/1.1 200 OK
< content-type: application/json; charset=utf-8
<
{
  "allowed": true,
  "usage": {
    "id": "48fd977c-3fe5-466e-b6f9-0dbfd36c86f4",
    "type": "ai_token",
    "qty": 15,
    "token_breakdown": { "input": 10, "cached_input": 0, "output": 5, "reasoning": 0 }
  },
  "deduped": false
}

$ send #2 (same key): curl -s -i -X POST http://127.0.0.1:44073/generate \
    -H "Content-Type: application/json" \
    -H "X-Tenant-Id: demo-tenant" \
    -H "Idempotency-Key: a06aeb8b-74f9-41fd-9a61-396d3a621b7b" \
    -d '{"tokens":{"input":10,"output":5}}'
< HTTP/1.1 200 OK
< content-type: application/json; charset=utf-8
<
{
  "allowed": true,
  "usage": {
    "id": "48fd977c-3fe5-466e-b6f9-0dbfd36c86f4",
    "type": "ai_token",
    "qty": 15,
    "token_breakdown": { "input": 10, "cached_input": 0, "output": 5, "reasoning": 0 }
  },
  "deduped": true
}

-- in-memory SELECT COUNT(*) equivalent:
   SELECT COUNT(*) FROM usage_events WHERE tenant_id='demo-tenant' => 1
   (rows in store for tenant: 1, total keys: 1)
```

Result: send #1 `200 deduped:false`, send #2 `200 deduped:true` with
identical `usage.id` (`48fd977c-...`), COUNT = 1. (UUIDs vary per run;
shape + `deduped` split is the assertion.)

## Probe 2 — Quota boundary 1000 allows / 1001 -> 429 (P2-T7, 2026-09-21)

Same ephemeral server; seeded 999 `api_call` rows (Free limit 1000), then
one fresh key (1000th, last allowed) and one more fresh key (1001st, deny):

```text
=== PROBE 2: boundary 999/1000 allow, 1001 -> 429 ===
-- seeded 999 api_call rows. COUNT => 999

$ 1000th request (999+1, last allowed): curl -s -i -X POST http://127.0.0.1:44073/generate \
    -H "Content-Type: application/json" -H "X-Tenant-Id: demo-tenant" \
    -H "Idempotency-Key: 108299ef-1717-4f71-ab6a-f522084d28c8" -d '{}'
< HTTP/1.1 200 OK
< content-type: application/json; charset=utf-8
<
{
  "allowed": true,
  "usage": { "id": "8f647356-9e80-4f58-b31f-0c3211d223b1", "type": "api_call", "qty": 1, "token_breakdown": null },
  "deduped": false
}
-- COUNT after 1000th => 1000

$ 1001st request (over limit): curl -s -i -X POST http://127.0.0.1:44073/generate \
    -H "Content-Type: application/json" -H "X-Tenant-Id: demo-tenant" \
    -H "Idempotency-Key: 9a3307ce-16e8-4456-a936-199a0e1d67bc" -d '{}'
< HTTP/1.1 429 Too Many Requests
< content-type: application/json; charset=utf-8
< retry-after: 60
<
{
  "reason": "quota_exceeded",
  "message": "quota exceeded: api limit reached (1000/1000 api, 0/100000 tokens). Retry after the reset window or upgrade to Pro for higher limits.",
  "retry_after": 60
}
-- COUNT after denied 1001st (must be unchanged) => 1000
```

Result: 1000th `200 allowed:true`, 1001st `429 reason:quota_exceeded`
with body + `Retry-After: 60` header, count stays 1000 (no event on deny).
402 `upgrade_required` path (lapsed `past_due` tenant, no event) is covered
by `tests/quota.test.ts` (`402 for lapsed tenant explains upgrade`) and
`tests/tdd.test.ts`; unit boundary 999/1000/1001 also in
`QuotaService boundary (P2-T4 unit)`.

## Test suite (P2-T7, 2026-09-21)

```text
✔ MeterService.record idempotent insert (P2-T3) (16.511984ms)
✔ POST /generate idempotent record (P2-T3, HTTP) (348.693702ms)
✔ QuotaService boundary (P2-T4 unit) (14.927721ms)
✔ POST /generate quota gate (P2-T4, HTTP) (439.093108ms)
✔ scaffold structure (7.730378ms)
✔ pricing constants (1.955112ms)
✔ migration (1.255135ms)
✔ manifests (4.543669ms)
✔ scaffold wiring (P2-T1) (313.51446ms)
✔ P2-T6 dedup edges (first-write-wins, deduped flag, cross-tenant 409) (288.50688ms)
✔ P2-T6 pro limits + tenant max deferred (128.635247ms)
✔ GET /usage rollup (P2-T5) (318.037193ms)
✔ POST /generate validation (P2-T2) (331.83018ms)
ℹ tests 54
ℹ suites 13
ℹ pass 54
ℹ fail 0
```

`npm run typecheck` (`tsc --noEmit`): clean, no output.

## Live-DB reproduction (review-gate env with Docker/Postgres)

Not runnable in the agent env (no Docker/Postgres — see `BLOCKED.md`
pattern from P2-T2..T6). Run where `docker compose up` works:

```bash
docker compose up --build &
sleep 5
npm run seed

# Probe 1: same key twice -> 1 row
KEY=$(uuidgen)  # must be uuidv4; Idempotency-Key middleware rejects non-v4
curl -s -i -X POST localhost:3000/generate \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: demo-tenant" -H "Idempotency-Key: $KEY" \
  -d '{"tokens":{"input":10,"output":5}}'
curl -s -i -X POST localhost:3000/generate \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: demo-tenant" -H "Idempotency-Key: $KEY" \
  -d '{"tokens":{"input":10,"output":5}}'
# expect: 1st 200 deduped:false, 2nd 200 deduped:true, same usage.id
docker compose exec -T db psql "$DATABASE_URL" \
  -c "SELECT COUNT(*) FROM usage_events WHERE idempotency_key = '$KEY';"
# expect: count = 1

# Probe 2: boundary (fresh tenant or reset demo-tenant first)
# 1000th allows:
curl -s -i -X POST localhost:3000/generate \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: demo-tenant" -H "Idempotency-Key: $(uuidgen)" -d '{}'
# 1001st -> 429 quota_exceeded + Retry-After: 60 (or 402 upgrade_required
# when tenants.status != 'active'):
curl -s -i -X POST localhost:3000/generate \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: demo-tenant" -H "Idempotency-Key: $(uuidgen)" -d '{}'
```

Prod SQL behind the proofs (`src/repos/usage.ts`): `INSERT ... ON CONFLICT
(idempotency_key) DO NOTHING RETURNING` (dedup) and
`SELECT COUNT(*) ... WHERE tenant_id = $1` (api usage) /
`SELECT COALESCE(SUM(qty),0) ... WHERE tenant_id=$1 AND type='ai_token'`
(token usage); quota gate `current + requested > limit` checked BEFORE
write (`src/services/quota.ts`, `src/routes/generate.ts`).

---

## Probe 3 — Checkout → webhook → Free→Pro → GET /usage Pro limits (P3-T5, 2026-09-21)

Env: no `.env`, no Stripe CLI, no Docker DB in this agent env (same
constraint as P2-T7). Proof runs the real Express app (`createApp`) on an
ephemeral port with the same in-memory seams used by
`tests/checkout.test.ts` / `tests/webhooks.test.ts` /
`tests/billing-sync.test.ts`: mocked `createSession` (returns
`https://checkout.stripe.com/...`, no network), SDK-signed webhook fixture
(`Stripe.webhooks.generateTestHeaderString` with `whsec_test_...`), dedup
via in-memory `Set` mirroring `stripe_events(event_id)` +
`ON CONFLICT DO NOTHING` (`src/repos/stripeEvent.ts`), billing via the real
`BillingService.applyStripeEvent` (`src/services/billing.ts`), plan limits
from `scripts/seed.ts` (free `1000/100000`, pro `100000/10000000`). Temp
script lived only in `.tmp/probe-p3t5.ts` (gitignored, not committed).

```text
USAGE_BEFORE {"plan":"free","api":{"used":0,"limit":1000},"tokens":{"used":0,"limit":100000}}
CHECKOUT {"checkout_url":"https://checkout.stripe.com/c/pay/cs_test_probe3_abc123"}
WEBHOOK_FIRST 200 {"received":true,"id":"evt_probe3_checkout_completed_1","event_id":"evt_probe3_checkout_completed_1","type":"checkout.session.completed"}
TENANT_AFTER_WEBHOOK {"plan":"pro","stripe_customer_id":"cus_test_probe_123"}
USAGE_AFTER {"plan":"pro","api":{"used":0,"limit":100000},"tokens":{"used":0,"limit":10000000}}
```

Result: `GET /usage` before shows `free 1000/100000`; `POST /checkout`
returns `checkout_url` shaped `https://checkout.stripe.com/...`; signed
`checkout.session.completed` webhook returns `200 received:true`; billing
apply flips tenant `free→pro` (customer `cus_test_probe_123` stored);
`GET /usage` after shows `pro 100000/10000000`. Unit cover in
`tests/checkout.test.ts` (happy path `creates session and returns
checkout_url`, Stripe params `mode:subscription` + Pro price +
`client_reference_id`/`metadata.tenant_id`, no secret leak) and
`tests/billing-sync.test.ts` (`completed flips free->pro + sub inserted`).

## Probe 4a — Forged/missing signature → 400, zero DB writes (P3-T5, 2026-09-21)

Same ephemeral server. Verification happens BEFORE any `stripe_events`
write (`src/routes/webhooks.ts` steps 1–4 → 400, step 5 dedup never
reached), so `markProcessed` delta is 0 on every reject:

```text
PROBE4A_MISSING 400 {"error":"missing_signature","message":"stripe-signature header required"} markProcessed_delta=0
PROBE4A_FORGED 400 {"error":"bad_signature","message":"No signatures found matching the expected signature for payload. ..."} markProcessed_delta=0
PROBE4A_DB_WRITES_ON_REJECT markProcessed_delta=0 stripe_events_size=1 applyCalls=1
```

(`stripe_events_size=1` / `applyCalls=1` are from the earlier Probe 3
success — the two rejects added zero rows and zero applies.)
`wrong-secret` and `tampered-payload` variants of the same `400
bad_signature` + zero-writes assertion are covered in
`tests/webhooks.test.ts` (`signature signed with wrong secret -> 400`,
`tampered payload -> 400`, `expired timestamp -> 400`).

Local forwarding line used against a live server (deferred, see below):

```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
```

## Probe 4b — Replay same event → applied once (P3-T5, 2026-09-21)

Same ephemeral server, fresh event id replayed twice. First delivery
applies (`markProcessed` true → `applyStripeEvent` runs); second hits the
dedup record (`markProcessed` false → `200 deduped:true`, no second apply),
mirroring `INSERT ... ON CONFLICT (event_id) DO NOTHING`:

```text
PROBE4B_REPLAY1 200 {"received":true,"id":"evt_probe4b_replay_1","event_id":"evt_probe4b_replay_1","type":"checkout.session.completed"}
PROBE4B_REPLAY2 200 {"received":true,"deduped":true,"id":"evt_probe4b_replay_1","event_id":"evt_probe4b_replay_1","type":"checkout.session.completed"}
PROBE4B_COUNT stripe_events_has_evt=true apply_delta=1 subscriptions_size=1 tenant_plan=pro
UNIT_MARK first=true second=false
```

Result: same event twice → first `200 received:true` (applied), second
`200 deduped:true`; `stripe_events` holds the id once, billing applied once
(`apply_delta=1`), subscriptions still 1 row (upsert), tenant updated once
(stays `pro`). HTTP-level cover in `tests/webhooks.test.ts` (`replay of
same signed event ... res2 deduped:true, applyCalls.length 1`); service
cover in `tests/billing-sync.test.ts` (`replay (call apply twice) -> still
one sub row + plan stays pro`); unit `markProcessed first true second
false` mirrors the `PRIMARY KEY (event_id)` contract
(`db/migrations/001_init.sql`, `src/repos/stripeEvent.ts`).

## Test suite (P3-T5, 2026-09-21)

```text
✔ BillingService.applyStripeEvent (P3-T4) (8 tests: completed flips free->pro, replay one sub row, updated syncs status/period x2, deleted downgrades to free, unknown type applied:false, metadata fallback, missing tenant applied:false)
✔ POST /checkout (P3-T2) (16 tests: validation 6, tenant 404 1, config/security 5, happy path 4)
✔ MeterService.record idempotent insert (P2-T3) (3 tests)
✔ POST /generate idempotent record (P2-T3, HTTP) (3 tests)
✔ QuotaService boundary (P2-T4 unit) (6 tests)
✔ POST /generate quota gate (P2-T4, HTTP) (6 tests)
✔ scaffold structure (2 tests)
✔ pricing constants (1 test)
✔ migration (1 test)
✔ manifests (2 tests)
✔ scaffold wiring (P2-T1) (6 tests)
✔ P2-T6 dedup edges (4 tests)
✔ P2-T6 pro limits + tenant max deferred (3 tests)
✔ GET /usage rollup (P2-T5) (5 tests)
✔ POST /generate validation (P2-T2) (12 tests)
✔ POST /webhooks/stripe verification (P3-T3) (15 tests: missing/malformed 3, body/payload 3, forged/bad 4, config 2, valid+replay 3)
ℹ tests 93
ℹ suites 25
ℹ pass 93
ℹ fail 0
```

`npm run typecheck` (`tsc --noEmit`): clean, no output, exit 0.

## Live-Stripe reproduction (Stripe-enabled review-gate env)

Not runnable in the agent env (no `.env`, no `stripe` CLI here — `stripe:
not found`; Postgres via Docker not started). Run where secrets + CLI +
Docker exist. Secrets placeholders only — never commit real keys (see
`.env.example`: `STRIPE_SECRET_KEY=sk_test_PLACEHOLDER`,
`STRIPE_WEBHOOK_SECRET=whsec_PLACEHOLDER`,
`STRIPE_PRO_PRICE_ID=price_PLACEHOLDER`).

```bash
docker compose up --build &
sleep 5
npm run seed   # Free/Pro plans + demo-tenant (scripts/seed.ts)

# 0. Authenticate the CLI (test mode only, sk_test_... / whsec_...):
stripe login

# 1. Forward live test webhooks to the local server:
stripe listen --forward-to localhost:3000/webhooks/stripe

# 2. Checkout flips Free->Pro (Probe 3 live):
curl -s -X POST localhost:3000/checkout \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"demo-tenant"}'
# expect: 200 {"checkout_url":"https://checkout.stripe.com/..."}
curl -s localhost:3000/usage -H "X-Tenant-Id: demo-tenant"
# expect: plan free, api.limit 1000, tokens.limit 100000
stripe trigger checkout.session.completed \
  --add checkout_session:client_reference_id=demo-tenant
# expect: webhook 200 {"received":true,...}, tenant plan pro
curl -s localhost:3000/usage -H "X-Tenant-Id: demo-tenant"
# expect: plan pro, api.limit 100000, tokens.limit 10000000

# 3. Bad signature -> 400, zero writes (Probe 4a live):
curl -s -i -X POST localhost:3000/webhooks/stripe \
  -H "Content-Type: application/json" \
  -H "stripe-signature: t=123,v1=deadbeef" \
  -d '{"id":"evt_forged_1","type":"checkout.session.completed","data":{"object":{}}}'
# expect: 400 {"error":"bad_signature",...}, no stripe_events row

# 4. Replay -> once (Probe 4b live): re-deliver the same event id twice,
# then confirm a single dedup row and a single tenant flip:
docker compose exec -T db psql "$DATABASE_URL" \
  -c "SELECT COUNT(*) FROM stripe_events WHERE event_id = '<evt-id-from-step-2>';"
# expect: count = 1
docker compose exec -T db psql "$DATABASE_URL" \
  -c "SELECT plan FROM tenants WHERE id = 'demo-tenant';"
# expect: plan = pro (updated once)
```

Prod SQL behind the Stripe proofs (`src/repos/stripeEvent.ts`,
`src/services/billing.ts`): `INSERT INTO stripe_events (event_id, type)
... ON CONFLICT (event_id) DO NOTHING RETURNING` (first true, replay
false); `UPDATE tenants SET plan/status ... WHERE id=$1` +
`INSERT INTO subscriptions ... ON CONFLICT (stripe_subscription_id) DO
UPDATE` (idempotent Free→Pro flip).

---

## Probe 5 — Cost: cached/reasoning/mixed totals + GET /usage match (P4-T4, 2026-09-21)

Env: same constraint as Probes 1–4 (no Docker/Postgres in agent env).
Proof runs the real Express app (`createApp` + `POST /generate` +
`GET /usage`) on an ephemeral port with the in-memory test seam from
`tests/cost.test.ts` (`sumTokenBreakdowns` per-tenant mirroring the
`SUM ... WHERE tenant_id=$1 AND type='ai_token'` query; cost via the real
`rollupCost`, `cost_cents = floor((input*1500 + cached*375 +
(output+reasoning)*6000) / 1M)`). Temp script lived only in
`.tmp/probe-p5t4.ts` (gitignored, not committed). Live-DB run deferred to
review-gate DB env (same `docker compose up` + curl pattern as Probes 1/2).

```text
ROLLUP cached 1M => 375 c (input 1M => 1500 c)
ROLLUP reasoning 1M => 6000 c (output 1M => 6000 c)
ROLLUP mixed 100k/200k/50k/30k => 705 c
POST /generate 200
GET /usage #1 {"cost_cents":705,"tokens":{"used":380000,"limit":10000000}}
GET /usage #2 {"cost_cents":705,"tokens":{"used":380000,"limit":10000000}} stable=true
```

Result: cached 1M bills 375c (1/4 of input 1500c — cached cheaper);
reasoning 1M bills 6000c (same as output — reasoning-as-output); mixed
`100k*1500 + 200k*375 + 80k*6000 = 705M / 1M = 705c` exact; `POST
/generate` mixed write → `GET /usage cost_cents 705` matches `rollupCost`
705c; second `GET /usage` identical (read path accrues nothing,
`stable=true`); tenant isolation (`demo 1500c / other 0c`) in suite.

TDD red→green: RED shown without touching `src/*` — classic buggy
formulas on the same inputs fail (`per-event-floor 10x100-input => 0`
vs correct 1; `blended-input-rate 1M-cached => 1500` vs correct 375;
`blended 1M-cached+1M-output => 3000` vs correct 6375). GREEN:
`tests/cost.test.ts` 12/12 (`CostService.rollup` 9 incl. 2 new P4-T4
`large volumes integer-safe` + `period rollup sums once`, `GET /usage`
3 incl. new `reads stable`), full `npm test` 114/114 pass 0 fail,
`npm run typecheck` (`tsc --noEmit`) clean exit 0. New edge cover:
1B-input → 1_500_000c integer-safe (numerator 1.5e12 ≪ 2^53), period
additive `rollup([a,b]) == rollup([combined]) == 705`, repeated
`GET /usage` deep-equal.

## Test suite (P4-T4, 2026-09-21)

```text
✔ cached bills at 1/4 input rate (1.497955ms)
✔ reasoning bills as output (0.25065ms)
✔ mixed breakdown pins deterministic cents total (0.277411ms)
✔ never sums raw tokens (cached-heavy regression) (0.365843ms)
✔ tiny events accrue via sum-then-floor (per-event floor would lose) (0.269546ms)
✔ 1c thresholds: ~667 input / ~2667 cached / ~167 output (0.232352ms)
✔ empty / zero -> 0, integers only (0.201668ms)
✔ large volumes stay integer-safe (P4-T4) (0.265018ms)
✔ period rollup sums each event once, no double-count (P4-T4) (0.273903ms)
✔ mixed write -> GET /usage cost_cents 705 matches rollup (144.072818ms)
✔ tenant isolation: cost scoped per tenant (21.319539ms)
✔ GET /usage reads are stable: repeated fetch same cost (P4-T4) (14.657441ms)
ℹ tests 12
ℹ suites 2
ℹ pass 12
ℹ fail 0
```

Full: `ℹ tests 114 / ℹ suites 30 / ℹ pass 114 / ℹ fail 0`.
`npm run typecheck`: clean, exit 0.
