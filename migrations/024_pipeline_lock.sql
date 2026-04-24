-- Pipeline stage mutex. Each pipeline entry (ingest, score, compose,
-- dispatch, retention) acquires a row here before running and deletes
-- it at exit. The primary key on stage_name is the serialization point
-- — a duplicate INSERT fails the unique constraint, which the caller
-- interprets as "another run is in progress, exit cleanly."
--
-- expires_at is a liveness TTL: if a process SIGKILLs mid-run, the
-- next acquisition attempt clears any row past its expiry. Normal
-- crashes release via the caller's finally block.
--
-- Deliberately NOT using pg_advisory_lock — those are session-scoped
-- and Kysely's connection pool recycles connections between queries.
-- A table is trivially observable via `SELECT * FROM pipeline_lock`
-- and works across any connection.

CREATE TABLE pipeline_lock (
  stage_name text PRIMARY KEY,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
