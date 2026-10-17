// Naive in-process rate limiter.
//
// Note: counters are never reset and never expire. The README claims a 60s
// reset; there is no such code. This is the deliberate trap in the fixture.

const hits = new Map<string, number>();

export function allow(key: string, limit = 100): boolean {
  const count = hits.get(key) ?? 0;
  if (count >= limit) return false;
  hits.set(key, count + 1);
  return true;
}

export function peek(key: string): number {
  return hits.get(key) ?? 0;
}
