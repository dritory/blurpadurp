-- Cold-storage tier, phase 1: ai_call_log payloads.
--
-- ai_call_log is the fastest-growing table (101 MB / 59k rows at the
-- time of writing — heap-heavy because scorer payloads are small enough
-- to sit inline, uncompressed). The input/output jsonb are read only by
-- within-run idempotency (findCachedOutput) and the admin drilldown, so
-- they belong in object storage (R2), not in Neon's 500 MB budget. See
-- docs/storage.md.
--
-- payload_key points at an R2 object holding {"input":..,"output":..}.
-- When set, input_jsonb/output_jsonb are NULL. Old rows keep their
-- inline jsonb (payload_key NULL) until the backfill mover relocates
-- them (`bun run cli cold-migrate`). The read path falls back to the
-- jsonb columns whenever payload_key is NULL, so this is safe to ship
-- before any data moves.

ALTER TABLE ai_call_log ADD COLUMN payload_key text;

-- Master switch for offloading. Off by default: the column and the
-- store plumbing ship inert until R2 creds are wired and a backfill is
-- run. Flip to true to start writing new payloads to the store.
INSERT INTO config (key, value) VALUES
  ('storage.cold_tier', 'false'::jsonb);
