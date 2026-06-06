# Integration tests

These exercise the DB-coupled layer (pipeline mutex, config/filter/blocklist
stores) against a **real Postgres** — they do not run in the default unit
suite (`bun test src`) and require a live `DATABASE_URL`.

## Run locally

```sh
docker compose up -d            # pgvector/pgvector:pg16 on :5432
DATABASE_URL=postgres://blurpadurp:dev@localhost:5432/blurpadurp bun run migrate
DATABASE_URL=postgres://blurpadurp:dev@localhost:5432/blurpadurp bun run test:integration
```

CI runs them in a dedicated job with a Postgres service container (see
`.github/workflows/ci.yml`). Each test truncates the tables it touches, so
they're order-independent.
