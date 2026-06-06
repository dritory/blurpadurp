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

// Is a timestamped action still inside its cooldown window? Used by
// POST /subscribe to skip re-sending a confirmation email to the same
// address within CONFIRMATION_COOLDOWN_MS (mig 061). A null `lastAt`
// (never acted) is never in cooldown.
export function withinCooldown(
  lastAt: Date | null,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  if (lastAt === null) return false;
  return now - lastAt.getTime() < windowMs;
}

// Extract the client IP from Hono's request headers.
//
// Trust order matters: X-Forwarded-For is appended-to by every hop and
// its leading entry is fully client-controlled, so trusting it lets an
// attacker rotate a fake IP per request and never hit the bucket. We
// prefer the single-value headers set by our actual edge — Fly's
// `Fly-Client-IP` (the immediate proxy in front of the app, which
// overwrites any client-supplied value) and Cloudflare's
// `CF-Connecting-IP` (set when the edge Worker fetches the origin).
// X-Forwarded-For / X-Real-IP remain only as a last-resort fallback for
// dev or unknown proxy setups.
export function clientIp(headers: Headers, remote?: string | null): string {
  const fly = headers.get("fly-client-ip");
  if (fly !== null && fly.length > 0) return fly;
  const cf = headers.get("cf-connecting-ip");
  if (cf !== null && cf.length > 0) return cf;
  const xff = headers.get("x-forwarded-for");
  if (xff !== null) {
    const first = xff.split(",")[0]?.trim();
    if (first && first.length > 0) return first;
  }
  const real = headers.get("x-real-ip");
  if (real !== null && real.length > 0) return real;
  return remote ?? "unknown";
}
