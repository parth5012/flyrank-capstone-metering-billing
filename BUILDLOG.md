# BUILDLOG.md - AI usage log (honesty graded)

## 2026-09-20 - Phase 1 design
- Used AI to summarize 10-page PDF brief into DESIGN.md + compare market (Stripe/Orb/Metronome/Lago).
- AI suggested Pro 100k/10M - kept, documented in README. Will verify pricing math manually in Phase 4.
- All schema/API decisions reviewed against probes 1-5; able to explain any 2-3 lines.

## 2026-09-21 - Phase 4 cost + jobs + pack (P4-T2..T5)
- AI drafted `CostService.rollup` (sum-then-floor), `src/jobs/*` (retry runner, 80/100 alerts, dry-run reconcile), and probe scripts. Kept after manual review: integer-only formula `floor((input*1500 + cached*375 + (output+reasoning)*6000)/1M)`, no per-event floor, no blended rates.
- AI was wrong once: first jobs draft put retry delays inline (untestable timers) — replaced with injected `sleep`/DI before accepting. Route-layer duplication flagged in review, parked as tech debt (see TECH_DEBT.md), not silently fixed.
- Manually verified: `tests/cost.test.ts` 12/12 (incl. 1B-input integer-safe, period additive, GET stable), full `npm test` 114/114, `npx tsc --noEmit` clean. No Docker/Postgres in agent env, so live-DB curl + `stripe trigger` deferred to review-gate env — EVIDENCE says so explicitly, no fake transcripts.
- Pack work (P4-T5): README stranger-can-run rewrite, capstone.yaml usage-header clarification, EVIDENCE Data/docs proofs — all hand-checked against `src/routes/*`, `db/migrations/001_init.sql`, and `git status` (no `.env`, placeholders only).
