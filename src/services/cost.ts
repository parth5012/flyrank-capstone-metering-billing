// CostService.rollup (P4-T2): integer-cents cost over token breakdowns.
// Pricing (src/config/pricing.ts, pinned): INPUT 1500c / CACHED 375c /
// OUTPUT 6000c per 1M tokens; reasoning bills as output (DESIGN.md §6).
// cost_cents = floor((input*INPUT + cached*CACHED + (output+reasoning)*OUTPUT) / 1M).
// Rounding (P4-T1 decision): sum numerators per category first, single
// Math.floor once, division last. Never per-event floor (loses sub-cent
// accrual: 10x100-input events = 1000 input = 1c, per-event floor gives 0).
// Never sum raw tokens x blended rate (cached-heavy 1M cached: correct 375c
// vs input-rate 1500c = 4x overbill, vs output-rate 6000c = 16x overbill).
// Integer-only: all rates/counts are ints, Math.floor on the final quotient;
// no FLOAT literals anywhere on this path. Replaces the P2-T1
// notImplemented(4) stub with the real rollup (scaffold pin kept in comment).
import {
  CACHED_PER_M_CENTS,
  INPUT_PER_M_CENTS,
  OUTPUT_PER_M_CENTS,
  TOKENS_PER_UNIT,
} from '../config/pricing';
import type { TokenBreakdown } from '../repos/usage';

export function rollupCost(breakdowns: TokenBreakdown[]): number {
  let input = 0;
  let cached = 0;
  let output = 0;
  let reasoning = 0;
  for (const b of breakdowns) {
    input += b.input;
    cached += b.cached_input;
    output += b.output;
    reasoning += b.reasoning;
  }
  const numerator =
    input * INPUT_PER_M_CENTS +
    cached * CACHED_PER_M_CENTS +
    (output + reasoning) * OUTPUT_PER_M_CENTS;
  return Math.floor(numerator / TOKENS_PER_UNIT);
}
