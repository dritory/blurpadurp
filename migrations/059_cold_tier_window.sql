-- Cold-tier offload window. Payloads (ai_call_log jsonb, story
-- raw_input/raw_output) stay inline in Postgres for this many days,
-- then the retention stage offloads them to R2 and nulls the columns.
-- 14 days comfortably clears compose's 7-day editor-pool freshness, so
-- no scheduled path ever fetches a payload from R2 — only offline
-- tuning (fixture-capture) and admin drilldowns of old items do. See
-- docs/storage.md.

INSERT INTO config (key, value) VALUES
  ('storage.cold_tier_age_days', '14'::jsonb);
