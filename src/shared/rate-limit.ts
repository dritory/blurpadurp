// In-memory IP rate-limiter. Good enough for a single-node deploy — if we
// ever run multi-node, replace with Postgres-based counting. The intent
// isn't to block a determined attacker (that's Cloudflare's job); it's to
// stop a naive script from filling email_subscription with garbage.

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimiter {
  take(key: string): boolean;
}

export function makeRateLimiter(params: {
  capacity: number; // max burst
  refillPerMs: number; // tokens replenished per ms
  maxKeys?: number; // evict oldest when we grow past this
}): RateLimiter {
  const capacity = params.capacity;
  const rate = params.refillPerMs;
  const maxKeys = params.maxKeys ?? 10_000;
  const buckets = new Map<string, Bucket>();

  function evictIfNeeded(): void {
    if (buckets.size <= maxKeys) return;
    // Evict the oldest half. Cheap and avoids unbounded growth; we don't
    // need LRU precision for this use case.
    const toRemove = Math.floor(buckets.size / 2);
    let i = 0;
    for (const k of buckets.keys()) {
      if (i++ >= toRemove) break;
      buckets.delete(k);
    }
  }

  return {
    take(key: string): boolean {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: capacity, lastRefill: now };
        buckets.set(key, b);
        evictIfNeeded();
      } else {
        const elapsed = now - b.lastRefill;
        b.tokens = Math.min(capacity, b.tokens + elapsed * rate);
        b.lastRefill = now;
      }
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    },
  };
}

// Extract the client IP from Hono's request headers. X-Forwarded-For wins
// if present (proxy deployments); falls back to the socket address.
export function clientIp(headers: Headers, remote?: string | null): string {
  const xff = headers.get("x-forwarded-for");
  if (xff !== null) {
    const first = xff.split(",")[0]?.trim();
    if (first && first.length > 0) return first;
  }
  const real = headers.get("x-real-ip");
  if (real !== null && real.length > 0) return real;
  return remote ?? "unknown";
}
