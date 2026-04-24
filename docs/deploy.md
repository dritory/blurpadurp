# Deploy

Stage-aware deploy recipe. See the "when should we put stuff online"
section of the design notes for which stage you're in; this doc covers
**stage 2** (operator-only, hidden) through **stage 4** (public).

Target platform: **Fly.io**. Chosen because Bun runs natively, managed
Postgres with pgvector is one command away, and pricing is predictable.

## 0. Prerequisites

- `flyctl` installed and authenticated (`fly auth login`)
- Anthropic API key with spending enabled
- Voyage AI API key
- Google Cloud service account JSON with BigQuery Data Viewer + Job User
- Domain name (optional until stage 4)
- Resend account + verified sending domain (only needed when dispatch lands)

## 1. Create Postgres with pgvector

```bash
fly postgres create --name blurpadurp-db --region ams --vm-size shared-cpu-1x --volume-size 10
fly postgres connect -a blurpadurp-db
# in psql:
CREATE EXTENSION vector;
\q
```

Grab the `DATABASE_URL` Fly prints — paste into the app's secrets in the next step.

## 2. Create the app

```bash
fly launch --name blurpadurp --no-deploy
```

When prompted about Postgres, skip it — we created it in step 1.
`fly launch` generates a `fly.toml`; confirm it reads:

```toml
app = "blurpadurp"
primary_region = "ams"

[build]

[env]
  PORT = "3000"
  NODE_ENV = "production"
  BLURPADURP_PUBLIC_URL = "https://blurpadurp.fly.dev"  # or your domain

[[services]]
  protocol = "tcp"
  internal_port = 3000
  [[services.ports]]
    port = 80
    handlers = ["http"]
    force_https = true
  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

[[services.http_checks]]
  interval = "30s"
  grace_period = "5s"
  method = "get"
  path = "/health"
  protocol = "http"
  timeout = "5s"
```

`/health` returns 503 when the DB is down — the HTTP check catches that.

## 3. Secrets

```bash
fly secrets set \
  DATABASE_URL='postgres://…'  \
  ANTHROPIC_API_KEY='sk-ant-…'  \
  VOYAGE_API_KEY='pa-…'  \
  GOOGLE_CLOUD_PROJECT='your-project' \
  BLURPADURP_TOKEN_SECRET="$(openssl rand -hex 32)" \
  ADMIN_USER='admin' \
  ADMIN_PASSWORD="$(openssl rand -hex 16)"
```

For BigQuery the service-account JSON needs a different path since
`GOOGLE_APPLICATION_CREDENTIALS` wants a file:

```bash
fly secrets set GCP_SA_KEY="$(cat service-account.json)"
```

And add to the Dockerfile / startup: write `$GCP_SA_KEY` to
`/tmp/sa.json` and export `GOOGLE_APPLICATION_CREDENTIALS=/tmp/sa.json`
before the app boots. (Fly's `processes` feature or a small entrypoint
script.)

## 4. Dockerfile

Minimal Bun image:

```Dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 3000
CMD ["bun", "run", "src/api/index.tsx"]
```

Commit this. `fly deploy` picks it up.

## 5. First deploy

```bash
fly deploy
fly logs           # watch it boot
curl https://blurpadurp.fly.dev/health
```

A 200 with JSON + `db_ok: true` confirms the DB is reachable.

## 6. Run migrations on the deployed DB

```bash
fly ssh console -C "bun run migrate"
```

(Or run locally against the Fly DB: `fly proxy 5432:5432 -a blurpadurp-db`
in one terminal, then `DATABASE_URL=postgres://... bun run migrate`.)

## 7. Stage 2: hide from crawlers

Set the flag while you're iterating on voice:

```bash
fly secrets set BLURPADURP_BLOCK_CRAWLERS=1
```

`/robots.txt` now returns `Disallow: /`. Remove the secret when going
public.

## 8. Schedule the pipeline

| Stage | Cadence | Why |
|---|---|---|
| `ingest` | hourly | RSS/GDELT refresh faster than daily; no LLM cost |
| `score` | chained into compose (see below) | Ensures every ingested story has a verdict before the week's brief is composed |
| `compose` | weekly, Sunday afternoon UTC | Product cadence — one brief a week |
| `dispatch` | hourly | New confirmations + breaking issues land near subscriber's delivery window |
| `retention` | daily | GDPR storage-limitation policy: prune unconfirmed subs + anonymize long-unsubscribed rows + trim old dispatch_log entries |

The `score` + `compose` chain matters: with ingest hourly and a daily
score job, the last 24 hours of stories are always unscored at compose
time and can't pass the gate. Chaining scores a final catchup pass
right before the weekly compose, so nothing ingested up to an hour
before the brief is dropped.

Fly Machines support scheduled runs. `--schedule` only accepts the
presets `hourly | daily | weekly | monthly | yearly` — no arbitrary
cron. The exact hour "weekly" fires is Fly's choice and doesn't matter
for this product: dispatch runs hourly and delivers each subscriber at
their own `delivery_time_local`, so compose can complete any time on
Sunday and everyone still gets it on their preferred morning.

```bash
# hourly ingest
fly machine run . --schedule hourly --region ams --name ingest \
  -a blurpadurp -- bun run cli ingest

# hourly dispatch — sends any issue published after a subscriber's
# confirmed_at that hasn't been dispatched yet.
fly machine run . --schedule hourly --region ams --name dispatch \
  -a blurpadurp -- bun run cli dispatch

# daily score — catchup pass on every unscored story. Fast when the
# prefilter is on; the progressive scorer only spends the expensive
# model on the top fraction.
fly machine run . --schedule daily --region ams --name score \
  -a blurpadurp -- bun run cli score

# weekly: chain another score pass + compose so the brief sees every
# ingestion up to an hour before it fires.
fly machine run . --schedule weekly --region ams --name weekly \
  -a blurpadurp -- /bin/sh -c 'bun run cli score && bun run cli compose'

# daily retention — prune unconfirmed subs (30d), anonymize
# unsubscribed (90d), trim old dispatch_log (180d). No API calls.
fly machine run . --schedule daily --region ams --name retention \
  -a blurpadurp -- bun run cli retention
```

**Syntax notes.** The `--` before the command is non-negotiable — it
marks the end of flytcl's own flags. Without it, flyctl silently drops
the command tokens and the machine boots with the Dockerfile's default
CMD (the HTTP server), doing nothing on its schedule. Also use
`--name` for each machine so `fly machine list` is readable; without
it you get names like `morning-snowflake-207`.

Verify immediately after creating each one:

```bash
fly machine status <id> -a blurpadurp
```

The VM block's `Command` field should show the command you passed. If
it's empty, the `--` separator didn't take and the machine needs to be
destroyed and recreated.

The `score` pass runs twice in a busy week (daily + chained into the
weekly). That's intentional and idempotent — the second run skips
anything already scored.

These machines share the app's image + secrets. They exit after running,
so there's no idle cost.

Alternative: host cron against `scripts/weekly-brief.sh`, which runs
ingest→score→compose→dispatch in sequence. Simpler ops on a single VPS,
no Fly-specific machine config.

### Budget check

At operator scale (solo + friends, hourly ingest, weekly compose):

| Line | Approx / month |
|---|---|
| Ingest | $0 (no LLM) |
| Score | $5–15 (Anthropic; lower end with prefilter on) |
| Compose + editor | $2 |
| Dispatch | $0 (Resend free tier covers it) |
| **Total Anthropic spend** | **$7–17** |

`budget.daily_usd_cap` in the config table is the circuit breaker —
the stages throw and exit when the day's spend crosses it.

## 9. Domain (stage 4)

```bash
fly certs create blurpadurp.com
# Point the DNS A/AAAA records per Fly's instructions.
fly secrets set BLURPADURP_PUBLIC_URL=https://blurpadurp.com
fly deploy
```

Remove `BLURPADURP_BLOCK_CRAWLERS` once the first couple of real issues
are live and readable.

## 10. Observability

- **Fly logs**: `fly logs -a blurpadurp` (live tail)
- **Health**: automatic via http_checks; any 503 triggers a restart
- **Costs**: `/admin/costs` — operator visits over basic-auth
- **Status**: `/admin/status` for freshness at a glance; `/health` JSON
  for anything scriptable (Uptime Kuma, healthchecks.io, etc.)

## Rollback

```bash
fly releases list
fly releases revert v<N>
```

If a bad prompt version landed, don't revert the deploy — use the admin
config editor (`/admin/config`) to flip `composer.prompt_version` or
`scorer.prompt_version` back to the previous committed version. Faster
than a deploy and safer.

## Cost estimate (single operator, weekly cadence, ~100 subscribers)

| Line item | Approx / mo |
|---|---|
| Fly app (shared-cpu-1x, 256MB) | $3 |
| Postgres w/ pgvector (Neon free tier, or Fly Machine + volume) | $0–5 |
| Anthropic (scorer + composer + editor) | $5–15 |
| Voyage embeddings | $0–2 |
| BigQuery (GDELT queries) | $0 (free tier) |
| Resend (transactional email) | $0 (free tier) |
| Domain | $1 |
| **Total** | **$9–26 / mo** |

Progressive scoring (see docs/scoring.md / src/pipeline/score.ts) cuts
the Anthropic line 3–5x once enabled — the cheap prefilter absorbs the
volume and the expensive model only sees the top fraction.
