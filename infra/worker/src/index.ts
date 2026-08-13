/// <reference types="@cloudflare/workers-types" />
//
// Blurpadurp edge Worker. Sits on the zone route (blurpadurp.com/*) and
// splits traffic:
//
//   - Static reader pages (/, /archive, /issue/<n>, /about, /privacy,
//     each also under the locale prefix /no/…, plus /feed.xml,
//     /sitemap.xml, /robots.txt) AND their sub-resources (/assets/* —
//     the brand mark, wave.js, the SVG favicon) → served straight from
//     the R2 bucket binding `STATIC`, which the publish pipeline fills
//     (src/pipeline/static-export.tsx). The Fly app is never touched.
//     (Serving /assets/* matters: otherwise the browser fires them at
//     the origin the instant it parses the R2-served HTML, waking Fly on
//     every reader visit.)
//   - Everything else (POST /subscribe, magic links, /webhooks/*,
//     /admin/*, /about, /status, …) → proxied to the Fly origin.
//
// Safe to deploy BEFORE the bucket is populated: an R2 miss falls
// through to the origin, so the Worker degrades to a plain caching
// proxy (Tier 0) until static-export starts writing objects (Tier 1).
//
// The path→key mapping below MUST stay in sync with the keys written by
// src/pipeline/static-export.tsx.

export interface Env {
  STATIC: R2Bucket;
  // Fly origin, e.g. "https://blurpadurp.fly.dev". Set in wrangler.toml.
  ORIGIN: string;
}

// Issue permalinks are immutable once published → cache hard. The
// rolling pages change on publish; a short edge TTL bounds staleness
// even if the publish-time purge is missed.
const TTL_IMMUTABLE = 86_400; // 1 day
const TTL_ROLLING = 60; // 1 min
// Assets are deploy-versioned, not content-versioned, and their URLs
// aren't fingerprinted — so bound staleness at a day rather than caching
// them hard. A redeploy + publish refreshes R2; the edge catches up
// within the TTL (or instantly via a manual cache purge).
const TTL_ASSET = 86_400; // 1 day

interface StaticMatch {
  key: string;
  contentType: string;
  ttl: number;
}

const HTML = "text/html; charset=utf-8";

// Locale URL prefixes, mirroring src/shared/i18n.ts LOCALE_PREFIX. The
// default locale is unprefixed and keeps the bare R2 keys; every other
// locale is served from a prefix directory of the same name, so /no/…
// reads no/….html. Keep this list and the export's localeKey() in sync.
const LOCALE_PREFIXES = ["/no"];

// Strip a known locale prefix, returning the remaining app path and the
// R2 key directory for it. An unknown prefix is not a locale.
function splitLocale(pathname: string): { path: string; dir: string } {
  for (const prefix of LOCALE_PREFIXES) {
    if (pathname === prefix) return { path: "/", dir: `${prefix.slice(1)}/` };
    if (pathname.startsWith(`${prefix}/`)) {
      return { path: pathname.slice(prefix.length), dir: `${prefix.slice(1)}/` };
    }
  }
  return { path: pathname, dir: "" };
}

// Map a request path for a known reader page to its R2 key. Returns null
// for anything that isn't one of the pre-rendered pages.
function pageTarget(pathname: string): StaticMatch | null {
  // Locale-agnostic surfaces first: one feed, one sitemap, one
  // robots.txt for the whole site, so they must not pick up a prefix.
  switch (pathname) {
    case "/feed.xml":
      return { key: "feed.xml", contentType: "application/atom+xml; charset=utf-8", ttl: TTL_ROLLING };
    case "/sitemap.xml":
      return { key: "sitemap.xml", contentType: "application/xml; charset=utf-8", ttl: TTL_ROLLING };
    case "/robots.txt":
      return { key: "robots.txt", contentType: "text/plain; charset=utf-8", ttl: TTL_ROLLING };
    // The layout sets an explicit <link rel="icon">, but crawlers and
    // older clients still probe /favicon.ico directly — and every miss
    // wakes the Fly origin. Map it to the same SVG mark the page links
    // to so the Worker serves it from R2.
    case "/favicon.ico":
      return { key: "assets/blurp.svg", contentType: "image/svg+xml", ttl: TTL_ASSET };
  }

  const { path, dir } = splitLocale(pathname);
  switch (path) {
    case "/":
      return { key: `${dir}home.html`, contentType: HTML, ttl: TTL_ROLLING };
    case "/archive":
      return { key: `${dir}archive.html`, contentType: HTML, ttl: TTL_ROLLING };
    // /about and /privacy are linked from the footer of every reader
    // page — without these the first click after a cached visit wakes
    // Fly. They're effectively static, so the publish pipeline renders
    // them into R2 alongside the rolling pages.
    case "/about":
      return { key: `${dir}about.html`, contentType: HTML, ttl: TTL_ROLLING };
    case "/privacy":
      return { key: `${dir}privacy.html`, contentType: HTML, ttl: TTL_ROLLING };
  }
  const m = path.match(/^\/issue\/(\d+)$/);
  if (m) {
    return { key: `${dir}issues/${m[1]}.html`, contentType: HTML, ttl: TTL_IMMUTABLE };
  }
  return null;
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
};

// Map /assets/<path> to its R2 key. The publish pipeline mirrors the
// ./public tree to R2 under `assets/<path>` (src/pipeline/static-export
// → exportPublicAssets). Reject traversal; fall through to origin on a
// miss like every other path.
function assetTarget(pathname: string): StaticMatch | null {
  if (!pathname.startsWith("/assets/")) return null;
  const rel = pathname.slice("/assets/".length);
  if (rel === "" || rel.includes("..")) return null;
  const ext = rel.includes(".") ? rel.slice(rel.lastIndexOf(".") + 1).toLowerCase() : "";
  return {
    key: `assets/${rel}`,
    contentType: ASSET_CONTENT_TYPES[ext] ?? "application/octet-stream",
    ttl: TTL_ASSET,
  };
}

function proxyToOrigin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const origin = new URL(url.pathname + url.search, env.ORIGIN);
  // Reuse method/headers/body; fetch sets Host from the origin URL.
  return fetch(new Request(origin.toString(), req));
}

// Serve a matched static object from R2, with an edge-cache fast path.
// On an R2 miss, fall through to the Fly origin (Tier 0 fallback), so
// the Worker is safe to deploy before the bucket is populated.
async function serveFromR2(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  match: StaticMatch,
): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) {
    return req.method === "HEAD"
      ? new Response(null, { status: cached.status, headers: cached.headers })
      : cached;
  }

  const obj = await env.STATIC.get(match.key);
  if (obj === null) return proxyToOrigin(req, env);

  const res = new Response(obj.body, {
    headers: {
      "Content-Type": match.contentType,
      "Cache-Control": `public, max-age=${match.ttl}`,
      "X-Blurp-Source": "r2",
    },
  });
  if (req.method === "GET") {
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }
  return new Response(null, { status: res.status, headers: res.headers });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const isRead = req.method === "GET" || req.method === "HEAD";
    if (!isRead) return proxyToOrigin(req, env);

    const match = assetTarget(url.pathname) ?? pageTarget(url.pathname);
    if (match === null) return proxyToOrigin(req, env);

    return serveFromR2(req, env, ctx, url, match);
  },
};
