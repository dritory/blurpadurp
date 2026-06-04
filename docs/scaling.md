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

## Secrets & tokens

Two homes, and **two distinct Cloudflare tokens** — don't reuse one for
the other.

**Fly app secrets** (`fly secrets set …`, runtime):

| Secret | What |
|---|---|
| `R2_PUBLIC_BUCKET` | `blurpadurp-pub` — turns the export on + names the bucket |
| `CLOUDFLARE_ZONE_ID` | the `blurpadurp.com` zone id (zone Overview → API sidebar) |
| `CLOUDFLARE_PURGE_TOKEN` | **custom** token, Zone → Cache Purge → Purge only |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT` | already set for cold storage; the token must also **write** the public bucket |

**GitHub Actions secrets** (repo → Settings → Secrets → Actions, CI):

| Secret | What |
|---|---|
| `CLOUDFLARE_API_TOKEN` | **template** token "Edit Cloudflare Workers" (Workers Scripts + R2 Storage + Workers Routes). NOT the purge token. |
| `CLOUDFLARE_ACCOUNT_ID` | account id (`wrangler whoami` or zone Overview → API sidebar) |

Token creation: use the **"Edit Cloudflare Workers" template** for the CI
token (it pre-fills every permission — you only set Account + Zone
resources); build a **custom** token with the single Cache Purge
permission for the app token. See
[Cloudflare: create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/).

## Testing the deploy

Run these in order — each one tells you which tier is actually live.

```bash
# 1. Worker is on the route and the site responds.
curl -sI https://blurpadurp.com/        # 200

# 2. Is it serving from R2 (Tier 1) or just proxying (Tier 0)?
curl -sI https://blurpadurp.com/ | grep -i x-blurp-source
#   x-blurp-source: r2   → served from the bucket, origin untouched (Tier 1)
#   (absent)             → bucket empty for this path; Worker fell through
#                          to Fly (Tier 0). Run the backfill in step 3.

# 3. Populate the bucket from current published issues, then re-check.
fly ssh console -C "bun run cli static-export"
curl -sI https://blurpadurp.com/ | grep -i x-blurp-source     # now: r2

# 4. The full static set carries the header + correct content types.
for p in / /archive /feed.xml /sitemap.xml /robots.txt /issue/1; do
  echo "$p"; curl -sI "https://blurpadurp.com$p" \
    | grep -iE 'x-blurp-source|content-type'
done
#   /feed.xml → application/atom+xml, /sitemap.xml → application/xml, etc.

# 5. Dynamic paths still reach Fly (no x-blurp-source, app renders them).
curl -sI https://blurpadurp.com/subscribe        # 200, served by origin
curl -sI https://blurpadurp.com/status           # DB-backed freshness JSON

# 6. Edge cache warms: first GET MISS, second HIT.
curl -sI https://blurpadurp.com/ | grep -i cf-cache-status   # MISS
curl -sI https://blurpadurp.com/ | grep -i cf-cache-status   # HIT
```

**The Tier-1 proof — reads survive the origin being down.** Stop (or let
autostop suspend) the Fly machine, then:

```bash
curl -s https://blurpadurp.com/ | head -c 200    # still serves (from R2/edge)
curl -sI https://blurpadurp.com/subscribe         # this one cold-starts/fails
```

A static page that loads while the app is asleep is the whole point.

**Publish → purge cycle.** Publish or recompose an issue, then confirm the
new content shows within a second or two (the publish-time `cdnPurge`),
not after the 60s edge TTL. Check the app log for
`static-export: wrote N objects …` and the absence of
`cdn purge failed`.

**Inspect the bucket directly** (sanity-check the keys match the Worker's
`keyFor`):

```bash
wrangler r2 object get blurpadurp-pub/home.html | head
# expect: home.html, archive.html, feed.xml, sitemap.xml, robots.txt,
#         issues/<n>.html
```

### If `x-blurp-source: r2` never appears

- **Bucket empty** → run the step-3 backfill, or publish an issue. Until
  then the Worker correctly falls through to Fly (Tier 0).
- **App not exporting** → `R2_PUBLIC_BUCKET` unset on Fly, or the app
  image predates this feature. `isStaticExportConfigured()` gates it.
- **Worker not on the route** → the apex/www DNS records aren't **proxied
  (orange cloud)**, so the route never attaches. Page still works (direct
  to Fly) but no Worker, no R2.
- **Key mismatch** → `keyFor()` in `infra/worker/src/index.ts` drifted
  from the keys `static-export.tsx` writes. They must match.
