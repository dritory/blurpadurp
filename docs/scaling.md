# Scaling reads

Blurpadurp's public product is, at heart, a static page that changes
about once a week. So the read path should not depend on the Fly app
being awake — readers should hit a CDN edge, and the brief should be
pre-rendered to object storage the edge serves directly. The app +
Neon exist for the *write* trickle (subscribe, magic links, webhooks,
admin) and the pipeline, not for reads.

```
                    ┌─────────────────────────────────────┐
  reader ──────────▶│ Cloudflare Worker (zone route /*)    │
                    │  static GET path?                    │
                    │   ├─ yes → R2 bucket  (binding STATIC)│──▶ R2 (private)
                    │   │         miss → fall through ↓     │
                    │   └─ no  → proxy ───────────────────┐ │
                    └──────────────────────────────────── │ ┘
                                                           ▼
                                              Fly app (Hono) ──▶ Neon
                                              (subscribe, magic links,
                                               webhooks, /admin, /about,
                                               /status, cache-fill misses)
```

The static surface is filled **eagerly at publish time**
(`src/pipeline/static-export.tsx` → `refreshStaticSurface`), not lazily
on first request like the in-app R2 page cache (`page-cache.ts`). That
cache stays as the origin's own fast path; the static export is the
edge's copy.

## Path → object-key map (keep in sync)

`src/pipeline/static-export.tsx` writes these; the Worker's `keyFor()`
(`infra/worker/src/index.ts`) reads them. **If you change one, change
the other.**

| URL | R2 key | Edge TTL |
|---|---|---|
| `/` | `home.html` | 60s (rolling) |
| `/archive` | `archive.html` | 60s |
| `/feed.xml` | `feed.xml` | 60s |
| `/sitemap.xml` | `sitemap.xml` | 60s |
| `/robots.txt` | `robots.txt` | 60s |
| `/issue/<n>` | `issues/<n>.html` | 1 day (immutable) |

Everything else (`/subscribe`, `/confirm/*`, `/unsubscribe/*`,
`/manage/*`, `/draft/*`, `/theme/*`, `/about`, `/privacy`, `/status`,
`/webhooks/*`, `/admin/*`) is proxied to Fly.

## Safety properties

- **Opt-in.** The publish-side export is a strict no-op until
  `R2_PUBLIC_BUCKET` is set (`isStaticExportConfigured`). The CDN purge
  is a no-op until `CLOUDFLARE_ZONE_ID` + `CLOUDFLARE_PURGE_TOKEN` are
  set. Production is unchanged until you wire these.
- **Best-effort.** Export and purge run *after* the publish transaction
  commits and are swallowed-and-logged; a failure can't roll back or
  block a publish.
- **Degrades cleanly.** The Worker falls through to the Fly origin on
  any R2 miss, so it's safe to deploy *before* the bucket is populated —
  it's just a caching proxy (Tier 0) until the first export lands, then
  upgrades to serving from R2 (Tier 1) automatically.

## Setup

### Your part (Cloudflare + Fly secrets)

1. **R2 bucket** (private — the Worker reads via binding):
   `wrangler r2 bucket create blurpadurp-pub`
2. **App write creds.** The Fly app needs to write that bucket. Reuse
   the existing R2 account creds (broaden the token to include the new
   bucket, or mint one with Object Read & Write on it) and set:
   ```bash
   fly secrets set R2_PUBLIC_BUCKET='blurpadurp-pub'
   # R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT already exist
   ```
3. **CDN purge token** (scoped to Zone → Cache Purge only) + zone id:
   ```bash
   fly secrets set CLOUDFLARE_ZONE_ID='…' CLOUDFLARE_PURGE_TOKEN='…'
   ```
4. **Worker.** Edit `infra/worker/wrangler.toml` (account_id, routes for
   your domain), then `cd infra/worker && wrangler deploy`. Make sure
   the apex/www DNS records are **proxied (orange cloud)** so the zone
   route attaches.
5. **Backfill** the bucket once (so existing issues are served from R2
   without waiting for the next publish):
   ```bash
   fly ssh console -C "bun run cli static-export"
   ```
   From then on, every publish / republish refreshes it automatically.

### What the code does (already in this repo)

- `src/pipeline/static-export.tsx` — renders all public pages (reusing
  the live view components + feed renderer) and uploads them to the
  public store. `renderStaticSurface` is pure and unit-tested.
- `src/shared/object-store.ts` — `getPublicObjectStore()` /
  `isStaticExportConfigured()`, a second R2 binding for the public
  bucket.
- `src/shared/cdn-purge.ts` — `cdnPurge()` against the Cloudflare API.
- `src/pipeline/draft.ts` — `publishDraft` and `replayReplaceIssue` call
  `refreshStaticSurface()` after busting the in-app cache.
- `src/cli.ts` — `bun run cli static-export` for manual/backfill runs.
- `infra/worker/` — the Worker, `wrangler.toml`, and deploy README.

## Verifying

```bash
curl -sI https://yourdomain.com/ | grep -i x-blurp-source   # → r2 once exported
curl -sI https://yourdomain.com/subscribe                   # still hits Fly
```

The `X-Blurp-Source: r2` header means the edge served it from the bucket
with no origin round-trip. Absent → not exported yet (run the backfill).
