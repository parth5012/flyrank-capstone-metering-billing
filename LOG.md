# Log

> Every iteration logged with status, what changed, and verification result.

## Format

Each entry:

- **Date**: YYYY-MM-DD HH:MM
- **Status**: Done | Blocked | Budget | Compacted | Stuck | Outage | Review
- **What**: Brief description of the task/change
- **Verified**: What was run to verify (tests, typecheck, etc.)
- **Notes**: Any decisions or learnings

## Entries

| Date | Status | What | Verified | Notes |
|------|--------|------|----------|-------|
| 2026-09-20 | Done | Harness setup: AGENTS.md, BLOCKED.md, LEARNINGS.md, LOG.md, TECH_DEBT.md, docs/architecture.md, docs/decisions.md, docs/patterns.md, docs/agents/ | Read README/DESIGN/capstone.yaml; no tests (pre-code, Phase 1) | Phase 1 design only; no src/ yet; graphify-out/ deferred |
