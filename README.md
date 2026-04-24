# Blurpadurp

One brief a week. No account, no tracking, no password.

A filter, run by a tired wizard. The whole product is the filter:
ruthlessly selective, silence is a feature, two-axis editorial (what
informed adults are actually discussing **and** what will still matter
in twelve months). Success metric is inverted: fewer minutes of the
reader's time per week is a better product.

If you want the philosophy, read [`docs/concept.md`](./docs/concept.md).

## Status

Pre-1.0. Prompts, schema, and behavior change without backwards
compatibility. Single-operator scale — not meant to be run by a
stranger off the shelf yet, though the code is open and the design is
all in [`docs/`](./docs).

## Stack

TypeScript on Bun. Hono for HTTP + JSX server rendering. Postgres with
pgvector for embeddings and theme clustering. Kysely for type-safe SQL.
Anthropic SDK directly (scorer, editor, composer). Voyage AI for
embeddings. Resend for email. Google BigQuery for the GDELT connector.

See [`docs/architecture.md`](./docs/architecture.md).

## Pipeline

```
ingest → score → editor → compose → dispatch
```

- **ingest** pulls from RSS, GDELT, Reddit r/OutOfTheLoop.
- **score** runs a cheap Haiku prefilter, then the expensive scorer on
  the top fraction. Embeds. Attaches to themes.
- **editor** curates 10–15 items from the gated pool on a two-axis
  rubric (loud × significant).
- **compose** partitions picks into four fixed sections server-side,
  then the composer writes prose per section.
- **dispatch** sends the brief via Resend; at-most-once per
  (issue, subscriber); respects the subscriber's delivery window.

## Layout

```
src/
├── api/               # Hono routes (public + admin)
├── ai/                # Anthropic-backed stages (scorer, editor, composer, ...)
├── connectors/        # One interface, N sources (rss, gdelt, reddit-ootl)
├── db/                # Kysely schema + migrator
├── pipeline/          # ingest / score / compose / dispatch / retention / ...
├── shared/            # mailer, svix verifier, rate limiter, env loader, tokens
└── views/             # JSX templates (public + admin)
docs/                  # design intent, prompts, deploy recipe
migrations/            # numbered .sql files applied by `bun run migrate`
scripts/               # entrypoint, weekly-brief, pg_dump_backup
```

## Local development

```
cp .env.example .env     # fill in ANTHROPIC_API_KEY, VOYAGE_API_KEY, …
docker compose up -d     # Postgres + pgvector
bun install
bun run migrate
bun run cli ingest       # pull latest from connectors
bun run cli score        # score unscored stories
bun run cli compose      # generate an issue if anything cleared the gate
bun run dev:api          # Hono on :3000
```

Admin UI (`/admin/*`) unlocks when `ADMIN_PASSWORD` is set.
[`docs/tuning.md`](./docs/tuning.md) walks through the prompt-iteration
loop (`fixture-capture`, `fixture-replay`, `composer-replay`,
`editor-replay`).

## Deploy

Fly.io + a Postgres provider with pgvector (Neon or Supabase free tier
both work). Recipe in [`docs/deploy.md`](./docs/deploy.md).

## Docs

- [`concept.md`](./docs/concept.md) — mission, non-negotiable rules, editorial voice
- [`architecture.md`](./docs/architecture.md) — pipeline, sources, data model
- [`scoring.md`](./docs/scoring.md) — rubric, gate, precision techniques
- [`scoring-prompt.md`](./docs/scoring-prompt.md) — the scorer prompt
- [`editor-prompt.md`](./docs/editor-prompt.md) — the editor prompt
- [`composer-prompt.md`](./docs/composer-prompt.md) — the composer prompt
- [`dispatch.md`](./docs/dispatch.md) — delivery guarantees, timezone handling
- [`tuning.md`](./docs/tuning.md) — prompt tuning loop
- [`deploy.md`](./docs/deploy.md) — Fly + Postgres recipe
- [`runbook.md`](./docs/runbook.md) — failure triage
- [`backtesting.md`](./docs/backtesting.md) — validation methodology
- [`open-questions.md`](./docs/open-questions.md) — unresolved decisions

## License

Dual-licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](./LICENSE-APACHE) or
  https://www.apache.org/licenses/LICENSE-2.0)
- MIT License ([LICENSE-MIT](./LICENSE-MIT) or
  https://opensource.org/license/mit)

at your option.

SPDX-License-Identifier: `Apache-2.0 OR MIT`
