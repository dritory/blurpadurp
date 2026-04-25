-- Move theme-attach thresholds out of code into the config table so
-- they're tunable live via /admin/config without a redeploy or a
-- re-score. Defaults match the values that were in score.ts as
-- constants at the time of this migration.
--
-- - theme.attach_threshold: cosine bar above which a candidate
--   neighbor theme triggers an LLM confirm. Lower = more confirms,
--   tighter clustering; higher = more singletons.
-- - theme.create_recheck_threshold: no-LLM short-circuit inside the
--   theme-create mutex (race window). Stays high (0.88) because the
--   point is to catch near-identical neighbors that appeared during
--   scoring.

INSERT INTO config (key, value) VALUES
  ('theme.attach_threshold',         '0.70'::jsonb),
  ('theme.create_recheck_threshold', '0.88'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
