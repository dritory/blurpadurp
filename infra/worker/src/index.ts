/// <reference types="@cloudflare/workers-types" />
//
// Blurpadurp edge Worker. Sits on the zone route (blurpadurp.com/*) and
// splits traffic:
//
//   - Anything the publish pipeline pre-rendered — the reader pages, the
//     feed/sitemap/robots, and the /assets/* sub-resources the pages pull
//     in — is served straight from the R2 bucket binding `STATIC`. The
//     Fly app is never touched. (Serving /assets/* matters: otherwise the
//     browser fires them at the origin the instant it parses the
//     R2-served HTML, waking Fly on every reader visit.)
//   - Everything else (POST /subscribe, magic links, /webhooks/*,
//     /admin/*, /status, …) → proxied to the Fly origin.
//
// Which paths are in the first group is NOT decided here. The publish
// pipeline writes `manifest.json` into the bucket describing every object
// it wrote and the path that serves it; this Worker reads that map. That
// replaced a hand-maintained path→key switch that had to agree with
// src/pipeline/static-export.tsx and, twice, didn't.
//
// Safe to deploy BEFORE the bucket is populated: no manifest means no
// routes, every request proxies to the origin, and the Worker degrades to
// a plain caching proxy (Tier 0) until the next publish writes one. To
// populate it without waiting for a publish, run `bun run cli
// static-export`.

import {
  lookupRoute,
  MANIFEST_KEY,
  parseManifest,
  type StaticManifest,
  type StaticRoute,
} from "./routes.ts";

export interface Env {
  STATIC: R2Bucket;
  // Fly origin, e.g. "https://blurpadurp.fly.dev". Set in wrangler.toml.
  ORIGIN: string;
}

// How long an isolate reuses a manifest before re-reading it from R2.
// A publish rewrites the manifest and purges the rolling pages; this
// bounds how long a warm isolate can keep resolving against the previous
// one. Short enough that a new issue's permalink is routable promptly,
// long enough that the read is amortised across ~all requests.
const MANIFEST_TTL_MS = 60_000;

// Per-isolate memo. Cloudflare keeps an isolate warm across requests, so
// in practice this is one R2 read a minute per isolate rather than one
// per request. A failed read caches `null` for the same window so a
// bucket problem can't turn into an R2 read on every request.
let cachedManifest: StaticManifest | null = null;
let cachedAtMs = 0;

async function loadManifest(env: Env): Promise<StaticManifest | null> {
  const now = Date.now();
  if (now - cachedAtMs < MANIFEST_TTL_MS) return cachedManifest;
  let next: StaticManifest | null = null;
  try {
    const obj = await env.STATIC.get(MANIFEST_KEY);
    if (obj !== null) next = parseManifest(await obj.text());
  } catch {
    // Treat a transport error like a miss: proxy to the origin.
    next = null;
  }
  cachedManifest = next;
  cachedAtMs = now;
  return next;
}

function proxyToOrigin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const origin = new URL(url.pathname + url.search, env.ORIGIN);
  // Reuse method/headers/body; fetch sets Host from the origin URL.
  return fetch(new Request(origin.toString(), req));
}

// Serve a matched static object from R2, with an edge-cache fast path.
// On an R2 miss, fall through to the Fly origin — so a manifest that
// lists an object the bucket doesn't have yet degrades to a slow read
// rather than a 404.
async function serveFromR2(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  route: StaticRoute,
): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) {
    return req.method === "HEAD"
      ? new Response(null, { status: cached.status, headers: cached.headers })
      : cached;
  }

  const obj = await env.STATIC.get(route.key);
  if (obj === null) return proxyToOrigin(req, env);

  const res = new Response(obj.body, {
    headers: {
      "Content-Type": route.contentType,
      "Cache-Control": `public, max-age=${route.ttl}`,
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

    const manifest = await loadManifest(env);
    const route = lookupRoute(manifest, url.pathname);
    if (route === null) return proxyToOrigin(req, env);

    return serveFromR2(req, env, ctx, url, route);
  },
};
