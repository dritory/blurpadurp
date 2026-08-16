# blurpadurp edge Worker

Fronts the site at the Cloudflare edge:

- **Static reader pages** (`/`, `/archive`, `/issue/<n>`, `/feed.xml`,
  `/sitemap.xml`, `/robots.txt`) **and their sub-resources** (`/assets/*`
  — the brand mark, `wave.js`, the SVG favicon) are served directly from
  the R2 bucket binding `STATIC`, which the publish pipeline fills
  (`src/pipeline/static-export.tsx`). The Fly app and Neon are never
  touched for reads. (Serving `/assets/*` from the edge is load-bearing:
  otherwise the browser fires them at the origin the instant it parses
  the R2-served HTML, waking Fly on every reader visit.)
- **Everything else** (`POST /subscribe`, magic links, `/webhooks/*`,
  `/admin/*`, `/about`, `/status`, …) is proxied to the Fly origin
  (`ORIGIN`).

An R2 miss falls through to the origin, so this is **safe to deploy
before the bucket is populated** — it behaves as a plain caching proxy
until `static-export` starts writing objects, then transparently
upgrades to serving from R2.

The Worker does **not** hold a path→key map. The publish pipeline writes
`manifest.json` into the bucket describing every object it wrote and the
path that serves it; `src/routes.ts` resolves requests against that.
Adding a page, a locale or an asset is a change to
`src/pipeline/static-export.tsx` alone — no Worker deploy needed, which
matters because `worker-deploy.yml` only fires on `infra/worker/**`.

`src/routes.ts` is deliberately free of Cloudflare types so the app's
test suite can import it and check the Worker's real resolver against
the export's real output.

## Deploy

**Normally you don't deploy by hand** — `.github/workflows/worker-deploy.yml`
runs `wrangler deploy` on every push to `main` that touches
`infra/worker/**` (and `deploy --dry-run` on PRs to validate the
bundle). It needs two GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN` — Workers Scripts:Edit + Workers R2 Storage:Edit.
  This is the **deploy** token; it is *not* the cache-purge token the
  app uses (`CLOUDFLARE_PURGE_TOKEN`, scoped to Zone → Cache Purge).
- `CLOUDFLARE_ACCOUNT_ID` — your account id.

One-time prerequisites (do these once, by hand):

```bash
# 1. Create the bucket. Private — the Worker reads via binding.
wrangler r2 bucket create blurpadurp-pub        # or via the R2 dashboard

# 2. Edit wrangler.toml: uncomment + set the routes for your domain.
#    (account_id comes from the CI secret; set it here too if you also
#    deploy locally.)
```

Then pushing to `main` deploys it. The apex/www DNS records for the
domain must be **proxied (orange cloud)** so the zone routes attach.

### Manual deploy (local, optional)

```bash
bunx wrangler deploy        # from infra/worker, after `wrangler login`
```

## Verify

```bash
# Served from R2 once exported (look for the header):
curl -sI https://blurpadurp.com/ | grep -i x-blurp-source   # x-blurp-source: r2

# Dynamic path still reaches Fly:
curl -sI https://blurpadurp.com/subscribe
```

If `x-blurp-source: r2` is absent, the page hasn't been exported yet —
run `bun run cli static-export` on the app side (needs `R2_PUBLIC_BUCKET`
+ R2 creds set) or publish/recompose an issue, which triggers the export
automatically.

## Local dev

```bash
wrangler dev
```

`wrangler dev` binds a local R2; `wrangler dev --remote` uses the real
bucket.
