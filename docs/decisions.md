# Architecture Decisions

> ADR-style log of significant decisions.

## Format

### [DATE]: [Title]

- **Status**: Proposed | Accepted | Superseded
- **Context**: Why this decision was needed
- **Decision**: What was decided
- **Consequences**: Trade-offs and implications

## Decisions

### 2026-09-21: Cost math is sum-then-floor with integer cents

- **Status**: Accepted
- **Context**: Per-event flooring loses sub-cent events; blended rates misprice cached/reasoning tokens.
- **Decision**: Sum per-category tokens across the period first, then one `floor` to cents (`src/services/cost.ts`); cached = 1/4 input, reasoning = output, integers only.
- **Consequences**: Tiny events accrue correctly; 1B-input numerators stay ≪ 2^53 (no float drift); pricing changes mean editing `src/config/pricing.ts` constants only.

### 2026-09-21: Jobs run off request path with injected timers

- **Status**: Accepted
- **Context**: Shared req #3 needs retries + failure alerts without blocking `/generate`.
- **Decision**: `src/jobs/runner.ts` (`runJobWithRetry`, exponential backoff) with injectable `sleep`/logger/alert-log; `alerts.ts` 80/100 thresholds; `reconcile.ts` dry-run read-only by construction (no insert/upsert deps exposed).
- **Consequences**: Fully unit-testable without waiting; prod wires a file-writing logger + scheduler; reconcile can only log mismatches, never auto-mutate.
