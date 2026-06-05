-- Remove orphaned scheduling config rows. `cadence.interval` and
-- `cadence.run_at_utc` were seeded by 001_init.sql back when the cadence
-- lived in the config table. Scheduling moved to the pipeline_schedule
-- table (039_pipeline_schedule) and these two keys have not been read by
-- any code since. Drop them so the config table reflects only live knobs
-- and /admin/config doesn't surface dead settings.

DELETE FROM config WHERE key IN ('cadence.interval', 'cadence.run_at_utc');
