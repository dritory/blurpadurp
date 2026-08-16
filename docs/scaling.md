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

## Path → object-key map (published, not duplicated)

`src/pipeline/static-export.tsx` is the only author of this map. It
writes `manifest.json` into the bucket next to the pages
(`src/shared/static-manifest.ts` builds it), and the Worker resolves
every request against that file rather than deriving keys itself
(`infra/worker/src/routes.ts`). **Adding a page, a locale or an asset is
a one-sided change** — no Worker deploy required, since the Worker
re-reads the manifest (per isolate, 60s TTL) rather than shipping the
routes in its bundle.

This replaced two hand-written maps joined by a "keep in sync" comment.
They drifted twice: `/assets/*` was added to the export and not the
Worker (waking Fly on every reader visit — see the table below for why
that row is load-bearing), and the Worker's `keyFor` was later renamed
without updating the three comments pointing at it.

`static-manifest.test.ts` and `static-export.test.ts` import the
Worker's real resolver and run it over the real export output, so a page
that stops being reachable from the edge fails CI rather than quietly
proxying to Fly.

The table below is therefore descriptive — the manifest is authoritative:

| URL | R2 key | Edge TTL |
|---|---|---|
| `/` | `home.html` | 60s (rolling) |
| `/archive` | `archive.html` | 60s |
| `/about` | `about.html` | 60s |
| `/privacy` | `privacy.html` | 60s |
| `/issue/<n>` | `issues/<n>.html` | 1 day (immutable) |
| `/no`, `/no/<page>`, `/no/issue/<n>` | same key under `no/` | as above |
| `/feed.xml` | `feed.xml` | 60s |
| `/sitemap.xml` | `sitemap.xml` | 60s |
| `/robots.txt` | `robots.txt` | 60s |
| `/assets/<path>` | `assets/<path>` | 1 day |

Locale note: the default locale keeps the bare keys, so adding a
language moved nothing at the edge. Feed, sitemap and robots are
deliberately **not** localized — one of each covers the whole site (the
sitemap enumerates every locale's URLs, and the pages carry `hreflang`
alternates saying they're translations of one another). A locale added
to `i18n.ts` but not rendered by the export simply isn't in the manifest
and proxies to Fly; the localized-path test catches that before it
ships.

**Empty bucket, or no manifest, is safe.** No manifest means no routes,
which means every request proxies to the origin — the Worker degrades to
a plain caching proxy (Tier 0) exactly as it did before the bucket was
populated. If you deploy the Worker before the next weekly publish, run
`bun run cli static-export` to write the manifest rather than waiting.
The manifest is written **last**, after every body is in place, so the
edge never resolves a route to an object that isn't there yet.

The `/assets/*` row is **load-bearing**: every reader page references
same-origin sub-resources (the brand mark `/assets/blurp.svg`, `wave.js`,
and the SVG favicon). If those aren't at the edge too, the browser fires
them at the Fly origin the instant it parses the R2-served HTML — waking
the machine on *every* reader visit even though the HTML itself came from
R2. `exportPublicAssets` mirrors the whole `./public` tree to R2 under
`assets/<path>`; the layout sets an explicit `<link rel="icon">` so the
browser stops probing `/favicon.ico` against the origin. Assets are
deploy-versioned (they change with code, not content), but re-uploading
the tree on each weekly publish is cheap and keeps the bucket
authoritative.

Everything else (`/subscribe` and `/no/subscribe`, `/confirm/*`,
`/unsubscribe/*`, `/manage/*`, `/draft/*`, `/theme/*`, `/status`,
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
4. **Worker.** Create the bucket once
   (`wrangler r2 bucket create blurpadurp-pub`) and set the `routes` for
   your domain in `infra/worker/wrangler.toml`. Deploy is then
   automated: `.github/workflows/worker-deploy.yml` runs `wrangler
   deploy` on every push to `main` touching `infra/worker/**` (and a
   dry-run on PRs). It needs two repo secrets — `CLOUDFLARE_API_TOKEN`
   (Workers Scripts:Edit + Workers R2 Storage:Edit; **not** the
   cache-purge token) and `CLOUDFLARE_ACCOUNT_ID`. Make sure the
   apex/www DNS records are **proxied (orange cloud)** so the route
   attaches. (`cd infra/worker && bunx wrangler deploy` still works for
   a manual/local deploy.)
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
curl -sI https://blurpadurp.com/                 | grep -i x-blurp-source   # → r2 once exported
curl -sI https://blurpadurp.com/assets/blurp.svg | grep -i x-blurp-source   # → r2 (no Fly wakeup)
curl -sI https://blurpadurp.com/subscribe                                   # still hits Fly
```

The `X-Blurp-Source: r2` header means the edge served it from the bucket
with no origin round-trip. Absent on `/` → not exported yet (run the
backfill). Absent on `/assets/*` → the asset push hasn't run; publish or
re-run `bun run cli static-export`. If the Fly machine still wakes on a
plain reader visit, that's the tell that a sub-resource is leaking to the
origin — confirm with `x-blurp-source` on each asset the page references.
