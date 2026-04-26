// Source-host blocklist. Read at the ingest boundary so blocked hosts
// never spend embedding/scoring credits. Writes happen via the admin
// "Block source" buttons on /admin/sources and the story drilldown.
//
// Subdomain rollup: a blocked host matches itself plus any subdomain.
// Blocking "nypost.com" therefore also blocks "video.nypost.com" and
// "www.nypost.com" without separate entries. We never block a TLD
// (com, co.uk) since that would nuke everything; the helper guards.

import { db } from "../db/index.ts";

// Normalize a hostname to the form we store and compare on:
// - lowercased
// - leading "www." stripped (an extremely common alias that nobody
//   wants to maintain explicit entries for)
// - trailing dots stripped (RFC-correct FQDNs sometimes have one)
export function normalizeHost(raw: string): string {
  let h = raw.trim().toLowerCase();
  if (h.startsWith("www.")) h = h.slice(4);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

// Pull the host out of a URL string. Returns null on URLs we can't
// parse, on relative paths, and on non-http(s) schemes — the ingest
// caller treats null as "not blocked, keep going."
export function extractHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return normalizeHost(u.hostname);
  } catch {
    return null;
  }
}

export interface Blocklist {
  has: (host: string) => boolean;
  size: number;
}

export async function loadBlocklist(): Promise<Blocklist> {
  const rows = await db
    .selectFrom("source_blocklist")
    .select("host")
    .execute();
  const set = new Set(rows.map((r) => normalizeHost(r.host)));
  return {
    size: set.size,
    has: (host: string) => isHostBlockedAgainst(host, set),
  };
}

// Subdomain rollup. Walk the host's parent domains; if any appears in
// the set, the host is blocked. Stops one label short of the bare TLD
// to avoid an entry like "com" nuking everything — but treats two-label
// hosts (foo.com) as bottom-level still, so blocking "foo.com" itself
// continues to work.
function isHostBlockedAgainst(host: string, set: Set<string>): boolean {
  const norm = normalizeHost(host);
  if (norm.length === 0) return false;
  if (set.has(norm)) return true;
  const labels = norm.split(".");
  // Walk from "a.b.c.example.com" upward, stopping at "example.com" —
  // never check just "com".
  for (let i = 1; i < labels.length - 1; i++) {
    const parent = labels.slice(i).join(".");
    if (set.has(parent)) return true;
  }
  return false;
}
