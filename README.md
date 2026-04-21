# Blurpadurp

The anti-social-media zeitgeist brief. Subscribe once, quit social media.

Design docs live in [`docs/`](./docs):

- [`concept.md`](./docs/concept.md) — mission, non-negotiable rules, scope
- [`architecture.md`](./docs/architecture.md) — pipeline, sources, data model, cost
- [`scoring.md`](./docs/scoring.md) — rubric, gate, precision techniques
- [`scoring-prompt.md`](./docs/scoring-prompt.md) — the actual scorer prompt (v0.1)
- [`backtesting.md`](./docs/backtesting.md) — validation methodology
- [`open-questions.md`](./docs/open-questions.md) — unresolved decisions

## Stack

TypeScript on Bun. Hono for HTTP + JSX server rendering. Postgres with
pgvector. Kysely for type-safe SQL. Anthropic SDK directly. See
[`docs/architecture.md`](./docs/architecture.md).

## Layout

```
src/
├── connectors/     # data sources (1 interface, N implementations)
├── ai/             # LLM stages: scorer, composer, theme classifier, ...
├── pipeline/       # orchestration — ingest → score → gate → compose → dispatch
├── db/             # Kysely schema + migrator
├── api/            # Hono routes
├── views/          # JSX templates
└── shared/         # Zod schemas, env loader
```

## Local development

```sh
cp .env.example .env           # fill in ANTHROPIC_API_KEY etc.
docker compose up -d           # Postgres + pgvector
bun install
bun run migrate                # apply migrations/*.sql
bun run cli ingest             # (stub) exercise the pipeline
bun run dev:api                # Hono on :3000
```

Pre-1.0. Schema and behavior may change without notice.
