# Patterns & Conventions

> Code patterns, naming conventions, and idioms specific to this project.

## Naming Conventions

- Tables (per DESIGN.md): `tenants`, `plans`, `subscriptions`, `usage_events` (`type` ENUM `api_call|ai_token`, `token_breakdown` JSONB `{input, cached_input, output, reasoning}`), `stripe_events`.
- Money fields in cents integers (`price_cents`, `cost_cents`); never FLOAT.

## Code Patterns

- Planned layering: `HTTP (Express routers + zod) -> Services (Meter/Quota/Cost/Billing) -> Repos (pg) -> Postgres`.
- Idempotency: `INSERT ... ON CONFLICT DO NOTHING RETURNING` on `UNIQUE(idempotency_key)` / `stripe_events(event_id)`.
- Quota: check `current + requested > limit` before write; boundary 1000 allows, 1001 → `429`/`402`.
- Cost: rollup sums per token category from `config/pricing.js`, never raw token adds.
- Tenant isolation: every query filters `tenant_id`.

## Testing Patterns

- `npm test` (per `capstone.yaml`); EVIDENCE.md checkboxes filled with pasted proof (double-curl idempotency, boundary probes, pricing unit output, `stripe trigger` logs). TDD: failing test first.

## Import/Module Conventions

_To be documented once `src/` is scaffolded (Node.js + Express + `pg` assumed)._
