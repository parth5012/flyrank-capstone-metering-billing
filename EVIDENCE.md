# EVIDENCE.md - one proof per Section 6 checkbox

> Claims without pasted proof score as not done. Fill as you build.

## Metering
- [x] Double-send same Idempotency-Key -> 1 row. Proof: ephemeral-server transcript (test seam, no Docker DB in agent env) + `npm test` 54 pass. Live Postgres `SELECT COUNT(*)` deferred to review-gate DB env — exact commands below.

## Quotas
- [x] Boundary 1000/1000 allows, 1001 -> 429/402 with message. Proof: ephemeral-server transcript below (seeded 999 -> 1000th 200, 1001st 429 `quota_exceeded` + `Retry-After: 60`, count unchanged). 402 `upgrade_required` covered by unit/HTTP tests (past_due tenant). Live-DB boundary curl deferred to review-gate DB env.

## Cost
- [ ] Pricing constants in `src/config/pricing.ts` + cached/reasoning math correct. Proof: `TODO: unit test output`
- [ ] GET /usage matches constants. Proof: `TODO`

## Stripe
- [ ] Test Checkout Free->Pro via webhook. Proof: `TODO: stripe trigger log`
- [ ] Bad signature -> 400, replay -> once. Proof: `TODO`

## Data/docs
- [ ] Migrations present, tenant isolation. Proof: `TODO`
- [ ] README + diagram + capstone.yaml present. Proof: `TODO: this file`

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
