# blurpadurp edge Worker

Fronts the site at the Cloudflare edge:

- **Static reader pages** (`/`, `/archive`, `/issue/<n>`, `/feed.xml`,
  `/sitemap.xml`, `/robots.txt`) are served directly from the R2 bucket
  binding `STATIC`, which the publish pipeline fills
  (`src/pipeline/static-export.tsx`). The Fly app and Neon are never
  touched for reads.
- **Everything else** (`POST /subscribe`, magic links, `/webhooks/*`,
  `/admin/*`, `/about`, `/status`, …) is proxied to the Fly origin
  (`ORIGIN`).

An R2 miss falls through to the origin, so this is **safe to deploy
before the bucket is populated** — it behaves as a plain caching proxy
until `static-export` starts writing objects, then transparently
upgrades to serving from R2.

The path→key map in `src/index.ts` (`keyFor`) **must stay in sync** with
the keys written by `src/pipeline/static-export.tsx`.

## Deploy

```bash
npm i -g wrangler           # or: bunx wrangler ...
cd infra/worker

# 1. Create the bucket (once). Private — the Worker reads via binding.
wrangler r2 bucket create blurpadurp-pub

# 2. Edit wrangler.toml: uncomment + set account_id and the routes
#    for your domain.

# 3. Deploy.
wrangler deploy
```

After deploy, the apex/www DNS records for the domain must be **proxied
(orange cloud)** so the zone routes attach to the Worker.

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
