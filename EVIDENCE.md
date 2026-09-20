# EVIDENCE.md - one proof per Section 6 checkbox

> Claims without pasted proof score as not done. Fill as you build.

## Metering
- [ ] Double-send same Idempotency-Key -> 1 row. Proof: `TODO: paste curl x2 + SELECT COUNT(*)`

## Quotas
- [ ] Boundary 1000/1000 allows, 1001 -> 429/402 with message. Proof: `TODO`

## Cost
- [ ] Pricing constants in `config/pricing.js` + cached/reasoning math correct. Proof: `TODO: unit test output`
- [ ] GET /usage matches constants. Proof: `TODO`

## Stripe
- [ ] Test Checkout Free->Pro via webhook. Proof: `TODO: stripe trigger log`
- [ ] Bad signature -> 400, replay -> once. Proof: `TODO`

## Data/docs
- [ ] Migrations present, tenant isolation. Proof: `TODO`
- [ ] README + diagram + capstone.yaml present. Proof: `TODO: this file`
