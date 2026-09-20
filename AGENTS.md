# AGENTS.md — Usage Metering & Billing Engine

## Project Overview

Backend service answering: how much used? what cost? over limit? Idempotent metering (`UNIQUE(idempotency_key)` + `ON CONFLICT DO NOTHING`), quota enforcement (`429`/`402`), token-aware cost math (integer cents, cached/reasoning splits), Stripe test-mode sync via verified webhooks. Phase 1 (design) done; implementation follows `DESIGN.md`, proofs go in `EVIDENCE.md`.

## Tech Stack

- **Language/runtime**: Node.js (Express). Python + FastAPI allowed as 1:1 swap — schema/contracts in `DESIGN.md` stay identical.
- **DB**: Postgres via Docker (`DATABASE_URL`), `pg` repos, SQL migrations, tenant-isolated queries.
- **Validation**: zod on HTTP layer. Money: integers only (cents/micro-cents), never FLOAT.
- **Payments**: Stripe test mode only (`sk_test_...`, `whsec_...`, Checkout + webhooks). Secrets in `.env`, never committed.
- **Package scripts** (per `capstone.yaml`, once scaffolded): `docker compose up --build` (run), `npm run seed` (Free/Pro plans + demo tenant), `npm test`.

## Code & File Operations

- **Understand-first**: check `graphify-out/graph.json` (`graphify query`) before reading files; no graph yet — read `DESIGN.md` + `README.md` first.
- **Minimal changes**: smallest diff that satisfies the spec; follow existing style (once code exists).
- **Systematic bug fixes**: reproduce → fix → verify; paste proof into `EVIDENCE.md`.
- **Never overwrite** existing files unless asked; create new files only when required.
- **Tenant isolation**: every query filters `tenant_id`; no cross-tenant reads.
- **Never commit secrets**: `.env` is gitignored (instant fail per brief §10). Only `.env.example` placeholders.

## Execution Guardrails

- **Plan-first** for multi-step tasks (migrations, endpoints, Stripe sync).
- **Safety zones**: no `rm -rf` / `git reset --hard` / `git push --force` without explicit approval.
- **Stage/commit/push/PR only when asked**.
- **Stripe**: test mode only, no real money. Webhooks: raw body, verify `stripe-signature` vs `whsec_`, dedup via `stripe_events`.
- **API contract**: `4xx` on validation, never `500` from `/generate`; quota boundary 1000/1000 allows, 1001 → `429`/`402`.

## How to use Harness Files

- **`BLOCKED.md`**: write here the moment you cannot proceed (missing secret, failing dep, ambiguous spec). Human resolves; check it at session start.
- **`LEARNINGS.md`**: append patterns, gotchas, decision rationale as discovered (pricing math, idempotency edge cases). Read before touching meter/quota/cost code.
- **`LOG.md`**: one row per work cycle (date, status, what, verified, notes). Write it when a task ends.
- **`TECH_DEBT.md`**: log deliberate shortcuts (deadline/scope choices) with rationale + impact — distinguishes debt from bugs.
- **`docs/architecture.md` / `docs/decisions.md` / `docs/patterns.md`**: source of truth for structure, ADRs, conventions. Update when they change.
- **`docs/agents/`**: issue-tracker, domain, triage-label conventions for engineering skills.
- **`.tmp/`**: scratch output only (gitignored); never put proofs only there — proofs belong in `EVIDENCE.md`.

## Verification

Primary (from `capstone.yaml`):
- `docker compose up --build`
- `npm run seed`
- `npm test`
- Smoke: `curl -H "X-Tenant-Id: demo-tenant" -H "Idempotency-Key: $(uuidgen)" localhost:3000/usage`

Per-area proofs (paste into `EVIDENCE.md`): double-send same `Idempotency-Key` → 1 row (`SELECT COUNT(*)`); boundary 1000 allows / 1001 → `429`/`402`; `config/pricing.js` constants + unit test output; `stripe trigger` log + bad-signature → 400 + replay → once.

## Definition of Done

- [ ] Tests green (`npm test`), no new lint/type errors
- [ ] E2E exercised via curl (usage + quota boundary where applicable)
- [ ] `EVIDENCE.md` checkbox filled with pasted proof (claims without proof = not done)
- [ ] Committed with detailed message (what changed, what verified, issue refs)
- [ ] Learnings logged (`LEARNINGS.md`), iteration logged (`LOG.md`)

## TDD

Failing test first → implement → verify green. Never write implementation before a failing test exists. Covers: idempotency dedup, quota boundary (999/1000/1001), pricing math (input/cached/output/reasoning-as-output), webhook verify + dedup.

## Context Re-entry

Cold re-entry rules: open with recap, plain language, self-contained questions, one question at a time, anchor with project/branch/PR, end with next action. State: metering-billing capstone, Phase 1 done, see `LOG.md` latest row + `EVIDENCE.md` checkboxes.

## Harness Patterns

- Teach via docs: point at `docs/` in live code; one item per fresh chat.
- Close the loop: verify + log + self-feedback every cycle.
- Spawn helper agents for research (market/pricing questions → `docs/MARKET_COMPETITION.md` first).
- Never compact chat mid-task; recover with git; loop anything repetitive.
- Fix bugs by updating instructions, not just patching code.
- Build spec (DESIGN.md section) before code; fill EVIDENCE.md as you build.

## Exit Codes & Statuses

`Done` | `Blocked` (see BLOCKED.md) | `Budget` | `Compacted` | `Stuck` | `Outage` | `Review`

## Artifacts

`BLOCKED.md`, `LEARNINGS.md`, `LOG.md`, `TECH_DEBT.md`, `EVIDENCE.md`, `BUILDLOG.md`, `docs/`, `.tmp/`

## Commit Standards

What changed + what verified + decisions rationale + issue references. Example: `feat(meter): idempotent record via UNIQUE(key); verified npm test + double-curl 1 row; keeps Lago-style dedup`. Keep Phase-1 style (see `a0c9ab1`).

## Concision

Extremely concise, sacrifice grammar. Facts > prose.

## Agent skills

- **Issue tracker**: Issues tracked via GitHub Issues using `gh` CLI. See `docs/agents/issue-tracker.md`.
- **Triage labels**: Five canonical labels mapping to roles. See `docs/agents/triage-labels.md`.
- **Domain docs**: Single-context domain document layout. See `docs/agents/domain.md`.
