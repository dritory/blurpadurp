-- Pipeline heartbeat: mail the operator when the pipeline is stuck, and
-- occasionally when it isn't.
--
-- The gap this closes is the one every incident in CLAUDE.md's failure
-- table shares: the system fails *quietly*. One forgotten draft stalled
-- compose for three weeks. The auto-fix retry loop filled Neon and
-- surfaced as "publish crashes". storage.cold_tier shipped false and the
-- tiering docs/storage.md describes may never have run. None of these
-- threw an exception anyone saw, and a blocked pipeline is
-- indistinguishable from a quiet week — which for this product is a
-- legitimate output, so there is nothing else to notice.
--
-- Two mechanisms ship together:
--
--   1. The scheduler's error path now mails on a stage throwing, rate
--      limited by consecutive-failure count (powers of two: 1, 2, 4, 8…).
--      Count-based rather than time-based because each tick is a fresh
--      process and any in-memory dedup is empty on arrival.
--   2. This stage: a digest that checks the things that never throw —
--      a stage that stopped being scheduled, a draft parked past its
--      staleness ceiling, spend against the cap, database size against
--      the free tier.
--
-- Runs every 6h rather than hourly. The check is a handful of indexed
-- reads, but the point of the free tier is that Neon gets to sleep, and
-- a stall worth mailing about is never six hours old by the time it
-- matters. It runs last in the tick, so its digest reports the state the
-- tick left rather than the one it found.

INSERT INTO pipeline_schedule (stage, interval_sec, enabled)
VALUES ('heartbeat', 21600, true)
ON CONFLICT (stage) DO NOTHING;

-- Don't repeat an alert digest more often than this while a problem
-- persists. The per-stage failure mail is the immediate channel; this is
-- the "still broken" reminder, and twice a day is enough of one.
INSERT INTO config (key, value) VALUES
  ('heartbeat.alert_interval_hours', '12'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Send an all-clear at least this often (weekly, matching the publish
-- cadence). This is the half that's easy to leave out and shouldn't be:
-- a monitor that only mails on failure cannot distinguish "healthy" from
-- "the monitor is dead too" — both are an empty inbox. The all-clear is
-- what makes silence informative.
INSERT INTO config (key, value) VALUES
  ('heartbeat.all_clear_interval_hours', '168'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Database size to measure against, in MB. Neon's free tier is ~500 MB;
-- 400 leaves room to act on the 80% warning rather than discovering the
-- ceiling as failing writes.
--
-- Note what pg_database_size does NOT capture: Neon bills branch history
-- for the PITR window too, so the real figure is higher and logical
-- deletes don't shrink it until history rolls (runbook #14). This is a
-- floor and a trend, not the bill — which is still exactly what was
-- missing when the auto-fix loop filled the disk.
INSERT INTO config (key, value) VALUES
  ('storage.db_budget_mb', '400'::jsonb)
ON CONFLICT (key) DO NOTHING;
