// Pricing constants - integers only (cents per 1M tokens). Never FLOAT.
// Reasoning tokens bill as output. Cached input bills at CACHED rate.
// cost_cents = floor((input*INPUT + cached*CACHED + (output+reasoning)*OUTPUT) / 1_000_000)
// Full math lands in Phase 4; values only here so tests can pin them.
export const TOKENS_PER_UNIT = 1_000_000;
export const INPUT_PER_M_CENTS = 1500;
export const CACHED_PER_M_CENTS = 375;
export const OUTPUT_PER_M_CENTS = 6000;
