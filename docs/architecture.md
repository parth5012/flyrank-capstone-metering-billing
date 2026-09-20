# Architecture — Usage Metering & Billing Engine

> As of 2026-09-20 (Phase 1: design only, no `src/` yet). Source: `README.md`, `DESIGN.md`, `capstone.yaml`.

## Project structure

```
.
├── README.md / DESIGN.md / EVIDENCE.md / BUILDLOG.md  # spec, proofs, AI log
├── capstone.yaml        # evaluator manifest (run/seed/test/endpoints)
├── docs/MARKET_COMPETITION.md
├── .env.example         # Stripe/Postgres placeholders (real .env gitignored)
├── AGENTS.md, BLOCKED.md, LEARNINGS.md, LOG.md, TECH_DEBT.md
└── (planned) src/, migrations/, config/pricing.js, docker-compose.yml
```

No code, `package.json`, or `docker-compose.yml` yet — repo is skeleton + design docs.

## Key modules (planned, per DESIGN.md §4)

| Layer | Responsibility |
|-------|----------------|
| HTTP (Express routers + zod) | `POST /generate`, `GET /usage`, `POST /checkout`, `POST /webhooks/stripe`; never 500 from `/generate` |
| `MeterService.record` | Idempotent ingest: `INSERT usage_events ... ON CONFLICT DO NOTHING RETURNING`; conflict → return original, no new event/cost |
| `QuotaService.check` | `current + requested > limit` before write; 1000/1000 allows, 1001 → `429`/`402` |
| `CostService.rollup` | Token-aware math from `config/pricing.js` (INPUT 0.15c/1k, CACHED 0.0375c/1k, OUTPUT 0.6c/1k, reasoning as output); integers only |
| `BillingService.sync` | Stripe Checkout + webhook apply (`checkout.session.completed`, `subscription.updated|deleted`) → `tenants.plan/status` + `subscriptions` |
| Repos (`pg`) → Postgres | Tenant-isolated queries; tables: `tenants`, `plans`, `subscriptions`, `usage_events`, `stripe_events` |
| Background job | Nightly `reconciliation` (DB vs Stripe) + `usage-alerts` at 80%/100% |

## Data flow

```
Client -> POST /generate -> MeterService.record(tenant,type,qty,key)
  duplicate key? -> return original (no new event)
  -> store usage_event -> Quota Check -> allow / 429,402
GET /usage <- rollup(usage_events) -> {used, limit, cost}
Stripe Checkout -> subscription
Stripe --signed--> POST /webhooks/stripe -> verify -> dedup -> update plan
```

## External dependencies

- Postgres (Docker), Stripe test mode (Checkout, webhooks, `stripe listen --forward-to localhost:3000/webhooks/stripe`).

## Entry points

`POST /generate` (headers `X-Tenant-Id`, `Idempotency-Key` uuidv4) · `GET /usage?tenant_id=` · `POST /checkout` · `POST /webhooks/stripe`. Base `http://localhost:3000`. Plans: Free `1000 API / 100k tokens`, Pro `100000 API / 10M tokens / $20`.

## Graphify graph location

`graphify-out/graph.json` — **not yet built** (pre-code corpus: 8 docs, no code; interpreter unavailable during setup). Build with `graphify .` once `src/` exists; future agents query it before reading files.
