# Market Competition - Usage Metering & Billing (2026)

This capstone is a mini version of a real $B category: usage-based billing for SaaS/AI. Use this to position your README and interviews.

## 1. Comparison table

| | Stripe Billing v2 | Orb (Adyen, $335M Jun 2026) | Metronome (Stripe, ~$1B Jan 2026) | Lago (AGPL open-source) | Amberflo |
|---|---|---|---|---|---|
| Model | % volume ~0.7%, Meters API async | Custom, billings+events + platform fee | Starter $100k vol + 10M events, then 0.8% + $0.04/1k ev | Free self-host / paid Cloud | Startup $99 / Growth $599 |
| Open source | No | No | No | Yes, self-host | No |
| Metering | Basic count/sum/last | Raw event-stream, SQL metrics, matrix pricing | Billions/mo, high-cardinality, 100k ev/s | REST/batch/Kafka, 500 rps | Metering + AI cost attribution |
| Best for | Startups on Stripe, simple tiers | Vercel, Perplexity - evolving pricing, backtest | OpenAI, Databricks - enterprise commits, contracts | Data residency, no lock-in, cost control | Margin + billing in one |
| Weakness | No native credits, >10M ev/mo struggles, async | Needs Stripe for payments, sales-led pricing | 4-8 week integration, enterprise price | You run Postgres/Redis, premium features gated | Smaller ecosystem |

## 2. What each teaches you
- **Stripe:** Checkout + webhooks + `whsec_` verify pattern you clone in Phase 3. Limit: aggregation logic stays in your code.
- **Orb:** Why we decouple metering from invoicing - change price without re-plumbing. Your `config/pricing.js` is a toy rate-card.
- **Metronome:** Commits/drawdowns, `effective_at` accounting. Your stretch `proration + reconciliation job` maps here.
- **Lago:** Closest to your build - `transaction_id` dedup = your `idempotency_key`, wallets = credits, Postgres self-host.
- **Consolidation 2026:** Metering pulled into payment rails. Lago left as neutral/self-host option.

## 3. Positioning this project
Don't claim to beat them. Claim: "Correct mini-Lago/Orb core: idempotent ingest, honest 429/402 boundaries, token-aware math, verified Stripe sync, with proofs in EVIDENCE.md."

Interview stories:
- Core: "Retried request bills once - UNIQUE(key) + ON CONFLICT DO NOTHING"
- Stretch pick one: overage billing (Orb-style), invoices, 80%/100% alerts, proration (Metronome-style hard), reconciliation job, full suite.

## 4. Sources (Sep 2026)
usagetracking.com 2026 comparison, kanopylabs.com Stripe v2 vs Orb vs Metronome, fintechspecs.com, dreaming.press (acquisitions), nodejs.tech Node.js guide, pkgpulse.com Lago vs Orb vs Metronome.
