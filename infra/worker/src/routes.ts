// Route resolution for the edge Worker, kept free of Cloudflare types so
// the app's test suite can import and exercise it directly (see
// src/shared/static-manifest.test.ts). index.ts holds everything that
// needs the runtime — R2, caches, fetch.
//
// The Worker no longer derives R2 keys from request paths. The publish
// pipeline writes `manifest.json` into the bucket alongside the pages
// (src/shared/static-manifest.ts builds it, src/pipeline/static-export.tsx
// writes it), and this module just looks paths up in it. Adding a page, a
// locale, or an asset is a change on the export side only.

/** Mirrors StaticRoute in src/shared/static-manifest.ts. */
export interface StaticRoute {
  key: string;
  contentType: string;
  ttl: number;
}

/** Mirrors StaticManifest in src/shared/static-manifest.ts. */
export interface StaticManifest {
  version: number;
  generatedAt: string;
  routes: Record<string, StaticRoute>;
}

/** The only manifest version this Worker understands. */
export const SUPPORTED_MANIFEST_VERSION = 1;

export const MANIFEST_KEY = "manifest.json";

/**
 * Canonical form of a request path. MUST match normalizeRequestPath in
 * src/shared/static-manifest.ts — the cross-boundary test pins them.
 */
export function normalizeRequestPath(pathname: string): string {
  if (pathname === "" || pathname === "/") return "/";
  const trimmed = pathname.endsWith("/")
    ? pathname.replace(/\/+$/, "")
    : pathname;
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Accept a parsed manifest only if it's a shape we understand. Anything
 * else (a future version, a truncated write, an unrelated object at that
 * key) resolves to null, and a null manifest means every request proxies
 * to the origin — slower, never wrong.
 */
export function parseManifest(text: string): StaticManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<StaticManifest>;
  if (candidate.version !== SUPPORTED_MANIFEST_VERSION) return null;
  if (typeof candidate.routes !== "object" || candidate.routes === null) {
    return null;
  }
  return {
    version: candidate.version,
    generatedAt:
      typeof candidate.generatedAt === "string" ? candidate.generatedAt : "",
    routes: candidate.routes,
  };
}

/**
 * Resolve a request path to the object that answers it, or null to let
 * the request fall through to the Fly origin.
 */
export function lookupRoute(
  manifest: StaticManifest | null,
  pathname: string,
): StaticRoute | null {
  if (manifest === null) return null;
  const route = manifest.routes[normalizeRequestPath(pathname)];
  if (route === undefined) return null;
  // A malformed entry is treated as a miss rather than trusted into a
  // Response with an undefined key.
  if (typeof route.key !== "string" || route.key === "") return null;
  return {
    key: route.key,
    contentType:
      typeof route.contentType === "string" && route.contentType !== ""
        ? route.contentType
        : "application/octet-stream",
    ttl: typeof route.ttl === "number" && route.ttl >= 0 ? route.ttl : 60,
  };
}
