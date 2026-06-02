-- Indexes to back the freshness queries in loadPipelineStatus
-- (src/api/status.ts). Without these, /health and /admin/status do
-- sequential scans on story (grows with every ingest) and on
-- ai_call_log (grows with every LLM call). At 10k+ stories the scan
-- cost is what makes Neon CU climb — compounded by Fly probing
-- /health every 60s. With these indexes, max() and the unscored
-- count are index-only lookups.

-- max(ingested_at) — index-only scan on the rightmost leaf.
CREATE INDEX IF NOT EXISTS story_ingested_at_idx
  ON story (ingested_at DESC);

-- max(scored_at) — same pattern; the partial filter keeps the
-- index smaller than a full one since unscored rows dominate the
-- table during catch-up periods.
CREATE INDEX IF NOT EXISTS story_scored_at_idx
  ON story (scored_at DESC)
  WHERE scored_at IS NOT NULL;

-- count(*) WHERE scored_at IS NULL AND early_reject = false — the
-- unscored backlog. Partial index on the exact predicate so the
-- count is the index size, no table touch.
CREATE INDEX IF NOT EXISTS story_unscored_idx
  ON story (id)
  WHERE scored_at IS NULL AND early_reject = false;

-- sum(cost_estimate_usd) WHERE started_at >= start_of_day. The
-- existing ai_call_log_stage_idx is (stage_name, started_at DESC)
-- and won't be used without a stage_name filter. A standalone
-- started_at index supports the today-spend rollup.
CREATE INDEX IF NOT EXISTS ai_call_log_started_at_idx
  ON ai_call_log (started_at DESC);
