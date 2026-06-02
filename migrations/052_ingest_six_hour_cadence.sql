-- Reduce ingest cadence from hourly to every 6h. Two motivations:
--
-- 1. Neon free-tier CU. Each ingest run wakes the DB for ~30s-2min,
--    and Neon's idle-suspend timeout is ~5 min, so an hourly ingest
--    keeps the DB warm continuously. 6h-spaced runs let the DB
--    suspend between batches.
-- 2. GDELT goes through BigQuery, which has per-query costs on the
--    free tier. Hourly BigQuery queries against partitioned tables
--    aren't free indefinitely.
--
-- Product-side this is fine: compose runs weekly, so a story
-- ingested 6h late instead of 1h late still lands in the same
-- editor pool. Breaking news that needs a mid-week issue goes
-- through urgent.ts and can be triggered manually from /admin.
--
-- Idempotent: only updates the row if it's still on the original
-- hourly default (3600s). If the operator already retuned this via
-- /admin/scheduler, we leave their choice alone.

UPDATE pipeline_schedule
SET interval_sec = 21600,
    updated_at = now()
WHERE stage = 'ingest'
  AND interval_sec = 3600;
