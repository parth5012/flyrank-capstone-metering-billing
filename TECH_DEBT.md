# Technical Debt

> Track tech debt separately to distinguish deliberate choices from bugs.
> When a decision is made for pragmatic reasons (deadline, scope), log it here.
> When a bug is actually a choice (not a mistake), log it here.

## Active Debt

_None yet — populate as the agent identifies debt during work._

| ID | Date | Description | Rationale | Impact | Effort to Fix |
|----|------|-------------|-----------|--------|---------------|
| TD-01 | 2026-09-20 | POST /generate records without quota check (QuotaService.check still stub; allow-all) | P2-T3 scope: meter record only; boundary 1000/1001 lands in P2-T4 | Over-limit tenants not rejected until P2-T4 | 1 ticket (P2-T4) |
| TD-02 | 2026-09-20 | No cost_cents in /generate response (CostService.rollup Phase 4) | Pricing math deferred; usage qty/breakdown recorded so rollup has inputs | Billing responses incomplete until Phase 4 | 1 ticket (Phase 4) |
| TD-03 | 2026-09-20 | Dedup tests use in-memory doubles, not live Postgres; setGenerateDeps seam in route | No Docker DB in this env; UNIQUE+ON CONFLICT semantics emulated first-write-wins | True concurrent-sender + SELECT COUNT(*) proof still required | 1 ticket (P2-T7 live proof) |

## Resolved Debt

_None yet._

| ID | Date Resolved | Description | Resolution |
|----|---------------|-------------|------------|
| —  | —             | —           | —          |
