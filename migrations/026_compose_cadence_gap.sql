-- compose.ts already blocks parallel runs via pipeline_lock and refuses
-- to overwrite an open draft. What it does NOT do is enforce a minimum
-- gap between consecutive published (non-event-driven) issues — once a
-- draft is published, the next compose run can produce another draft
-- the same hour. This config key adds a cadence-window guard.
--
-- Default 144 hours (6 days) lets a true-weekly cadence run on a
-- slightly-off-by-an-hour cron without false skips, while still
-- preventing same-day double-issue mistakes.
INSERT INTO config (key, value) VALUES
  ('compose.min_publish_gap_hours', '144'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
