# Blurpadurp

One brief a week. No account, no tracking, no password.

A filter, run by a tired wizard. The brief publishes when something
actually clears the bar, nothing otherwise; success is fewer minutes of
your week, not more. Two axes: what informed adults are actually
discussing, and what will still matter in twelve months.

TypeScript on Bun. Hono for HTTP + JSX server rendering. Postgres with
pgvector. Anthropic for scoring, editing, and composition. Voyage for
embeddings. Resend for email.

Pre-1.0 — schema and prompts change without backwards compatibility.

## Running locally

Copy `.env.example` to `.env` and fill in the API keys. Then:

```sh
docker compose up -d
bun install
bun run migrate
bun run cli ingest
bun run cli score
bun run cli compose
bun run dev:api
```

See `docs/concept.md` for the philosophy, `docs/deploy.md` for the Fly
+ Neon recipe, `docs/tuning.md` for the prompt-iteration loop.

Dual-licensed Apache-2.0 OR MIT. Copyright © 2026 Endre Dåvøy Vestå.
