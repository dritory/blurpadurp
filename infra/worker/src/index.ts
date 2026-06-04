/// <reference types="@cloudflare/workers-types" />
//
// Blurpadurp edge Worker. Sits on the zone route (yourdomain.com/*) and
// splits traffic:
//
//   - Static reader pages (/, /archive, /issue/<n>, /feed.xml,
//     /sitemap.xml, /robots.txt) → served straight from the R2 bucket
//     binding `STATIC`, which the publish pipeline fills
//     (src/pipeline/static-export.tsx). The Fly app is never touched.
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

interface StaticMatch {
  key: string;
  contentType: string;
  ttl: number;
}

function keyFor(pathname: string): StaticMatch | null {
  switch (pathname) {
    case "/":
      return { key: "home.html", contentType: "text/html; charset=utf-8", ttl: TTL_ROLLING };
    case "/archive":
      return { key: "archive.html", contentType: "text/html; charset=utf-8", ttl: TTL_ROLLING };
    case "/feed.xml":
      return { key: "feed.xml", contentType: "application/atom+xml; charset=utf-8", ttl: TTL_ROLLING };
    case "/sitemap.xml":
      return { key: "sitemap.xml", contentType: "application/xml; charset=utf-8", ttl: TTL_ROLLING };
    case "/robots.txt":
      return { key: "robots.txt", contentType: "text/plain; charset=utf-8", ttl: TTL_ROLLING };
  }
  const m = pathname.match(/^\/issue\/(\d+)$/);
  if (m) {
    return { key: `issues/${m[1]}.html`, contentType: "text/html; charset=utf-8", ttl: TTL_IMMUTABLE };
  }
  return null;
}

function proxyToOrigin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const origin = new URL(url.pathname + url.search, env.ORIGIN);
  // Reuse method/headers/body; fetch sets Host from the origin URL.
  return fetch(new Request(origin.toString(), req));
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const isRead = req.method === "GET" || req.method === "HEAD";
    const match = isRead ? keyFor(url.pathname) : null;

    if (match === null) return proxyToOrigin(req, env);

    // Edge cache lookup first (keyed on the normalized GET URL).
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) {
      return req.method === "HEAD"
        ? new Response(null, { status: cached.status, headers: cached.headers })
        : cached;
    }

    const obj = await env.STATIC.get(match.key);
    if (obj === null) {
      // Not exported yet → let the origin render it (Tier 0 fallback).
      return proxyToOrigin(req, env);
    }

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
  },
};
