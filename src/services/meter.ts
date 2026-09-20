// MeterService.record - TODO Phase 2. UNIQUE(idempotency_key) + ON CONFLICT DO NOTHING.
export function notImplemented(phase: number | string): never {
  throw Object.assign(new Error('not_implemented'), { phase });
}

export async function recordUsage(): Promise<never> {
  return notImplemented(2);
}
