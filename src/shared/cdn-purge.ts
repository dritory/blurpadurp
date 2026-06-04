// Cloudflare cache purge. Called after a publish so the rolling reader
// pages (home/archive/feed/sitemap) update at the edge immediately
// rather than waiting out the Worker's short edge TTL. See
// docs/scaling.md.
//
// Gated on CLOUDFLARE_ZONE_ID + CLOUDFLARE_PURGE_TOKEN (a token scoped
// to Zone → Cache Purge only). Absent either, this is a no-op — same
// best-effort posture as the object store: the feature degrades to
// "show within one edge-TTL" rather than failing the publish.

import { getEnvOptional } from "./env.ts";

export type PurgePath = `/${string}` | "/";

export function cdnPurgeConfigured(): boolean {
  return (
    getEnvOptional("CLOUDFLARE_ZONE_ID") !== undefined &&
    getEnvOptional("CLOUDFLARE_PURGE_TOKEN") !== undefined
  );
}

// Purge specific URLs from Cloudflare's edge cache. Paths are resolved
// against BLURPADURP_PUBLIC_URL into absolute URLs (what the purge API
// expects). Throws on a transport error; callers treat it as
// best-effort and swallow.
export async function cdnPurge(paths: PurgePath[]): Promise<void> {
  const zone = getEnvOptional("CLOUDFLARE_ZONE_ID");
  const token = getEnvOptional("CLOUDFLARE_PURGE_TOKEN");
  const base = getEnvOptional("BLURPADURP_PUBLIC_URL");
  if (zone === undefined || token === undefined || base === undefined) return;
  if (paths.length === 0) return;

  const files = paths.map((p) => `${base.replace(/\/$/, "")}${p}`);
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ files }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`cdn purge failed: ${res.status} ${detail}`.trim());
  }
}
