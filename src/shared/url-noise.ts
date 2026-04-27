// Tag-only URL classifier. Returns the matched pattern (or null) so
// stories can be flagged at ingest without being dropped — we tag
// first, evaluate the false-positive rate from real data, and decide
// later whether any pattern earns promotion to a hard ingest filter.
//
// Patterns are substring-matched against a lowercased URL; first
// match wins (order matters only if patterns overlap, which they
// shouldn't in practice). Backfill SQL in migration 038 mirrors this
// logic — keep them in sync if patterns change.

const PATTERNS = ["/entertainment/", "/viral/"] as const;

export function classifyUrlNoise(url: string | null): string | null {
  if (url === null) return null;
  const lower = url.toLowerCase();
  for (const p of PATTERNS) {
    if (lower.includes(p)) return p;
  }
  return null;
}
