// The contract between the publish-time static export and the edge
// Worker: which request path is served by which R2 object.
//
// This used to be two hand-written maps — `renderStaticSurface()` chose
// the keys, the Worker's `keyFor()` re-derived them from the request
// path, and a comment on each side asked the next person to keep them in
// agreement. That held until it didn't: /assets/* was added to the export
// and not to the Worker, so every reader visit fetched the logo off the
// origin and woke Fly — the exact cost the edge cache exists to avoid.
// By the time this file was written the Worker had also renamed `keyFor`
// to pageTarget/assetTarget, and all three comments pointing at it were
// stale.
//
// So the export now publishes its own map. `manifest.json` sits in the
// bucket next to the pages it describes, the Worker reads it instead of
// guessing, and adding a page, a locale, or an asset is a one-sided
// change again.
//
// The Worker deliberately does NOT import this module — it's a separate
// wrangler build, and `worker-deploy.yml` only fires on infra/worker/**,
// so a shared import would be a change that silently doesn't deploy.
// What it imports instead is the *data*, at runtime, from R2. The JSON
// shape below is the whole interface; `infra/worker/src/routes.ts`
// restates the types and the path-normalisation rule, and
// `static-manifest.test.ts` pins the two together by running the Worker's
// own resolver against a manifest built here.

/** Object key the manifest itself lives at, inside the public bucket. */
export const MANIFEST_KEY = "manifest.json";

/**
 * Bumped only for a breaking change to the shape below. The Worker
 * ignores a manifest whose version it doesn't know and falls through to
 * the origin, which is the same safe degradation as an empty bucket —
 * so an old Worker meeting a new manifest serves slowly, never wrongly.
 */
export const MANIFEST_VERSION = 1;

// Issue permalinks are immutable once published, so they cache hard. The
// rolling pages change on publish; a short edge TTL bounds staleness even
// if the publish-time purge is missed. Assets are deploy-versioned and
// their URLs aren't fingerprinted, so they get a day rather than forever.
export const TTL_ROLLING = 60;
export const TTL_IMMUTABLE = 86_400;
export const TTL_ASSET = 86_400;

export const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

export interface StaticRoute {
  /** R2 object key holding the body. */
  key: string;
  contentType: string;
  /** Edge cache lifetime in seconds. */
  ttl: number;
}

export interface StaticManifest {
  version: number;
  /** ISO timestamp of the export that wrote this manifest. */
  generatedAt: string;
  /** Normalised request path → object. */
  routes: Record<string, StaticRoute>;
}

/** A single addressable thing the export publishes. */
export interface StaticEntry extends StaticRoute {
  /** Public request path this object answers, e.g. "/no/archive". */
  path: string;
}

/**
 * Canonical form of a request path for manifest lookup. Applied on both
 * sides — the export when writing keys, the Worker when reading them —
 * so "/archive/" and "/archive" can't resolve differently.
 *
 * Trailing slashes are dropped (except on the root) and an empty path is
 * the root. Query strings and fragments are already gone by the time a
 * Worker sees `url.pathname`; callers passing a raw URL should not.
 */
export function normalizeRequestPath(pathname: string): string {
  if (pathname === "" || pathname === "/") return "/";
  const trimmed = pathname.endsWith("/") ? pathname.replace(/\/+$/, "") : pathname;
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Fold entries into the published manifest. Later entries win on a path
 * collision, which is what makes the /favicon.ico alias expressible
 * without a special case at the edge.
 */
export function buildManifest(
  entries: StaticEntry[],
  generatedAt: Date,
): StaticManifest {
  const routes: Record<string, StaticRoute> = {};
  for (const entry of entries) {
    routes[normalizeRequestPath(entry.path)] = {
      key: entry.key,
      contentType: entry.contentType,
      ttl: entry.ttl,
    };
  }
  return {
    version: MANIFEST_VERSION,
    generatedAt: generatedAt.toISOString(),
    routes,
  };
}
