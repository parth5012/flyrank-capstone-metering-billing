# Learnings

> Key learnings, edge cases, and concepts worth remembering for this project.

## Project-Specific Learnings

- P2-T3: idempotency guarantee lives in DB UNIQUE(idempotency_key) + ON CONFLICT DO NOTHING, never app pre-check (race-unsafe). Repo conflict path re-reads scoped by tenant_id so a key from another tenant never leaks.
- P2-T3: replay envelope returns identical `usage` + `deduped:true` flag (usage/cost equal, envelope notes replay). Tokens present -> ai_token qty=sum(input+cached+output+reasoning), breakdown defaults missing fields to 0; absent -> api_call qty 1, breakdown null.
- P2-T3: outer catch in generate.ts must default to 500 (errorMiddleware coerces to 503 on /generate, keeps never-500 contract); forcing 400 there would mislabel DB faults as validation errors.

## Decision Log

- Test seam `setGenerateDeps` on generate route (prod defaults = pg repos, null restores): lets HTTP dedup tests run without Docker DB. Live-DB double-curl proof deferred to P2-T7 (TECH_DEBT TD-03).
- Validation tests updated 501->200 for valid requests (P2-T2 precedent: contract evolves, stale pins updated); error-shape assertion scoped to >=400 so 200 bodies aren't forced into {error,message}.

## Decision Log

> Why decisions were made, alternatives considered, and consequences.

_None yet._

## Edge Cases

> Known edge cases, gotchas, and non-obvious behaviors discovered during work.

_None yet._
