-- Retention rule 6: prune unscored noise stories.
--
-- The lever docs/storage.md sized but never built. Its words: "The
-- biggest row population is stories that never scored (ingest/filter
-- noise). They carry no persist-forever obligation (the invariant covers
-- *scored* raw_* only), so retention can prune unscored, unreferenced
-- stories past a short TTL — pure win, no R2, no invariant impact."
--
-- Every ingest cycle writes a story row per item that clears the
-- blocklist/title/path filters. Only 10-15 a week are ever published,
-- and a large share are never scored at all — deduped away, filtered
-- after the write, or simply never reached by a scorer run. Those rows
-- are monotonic and they are the population that fills a fixed 500 MB.
--
-- Invariant 3 ("every scored item is persisted forever") is untouched by
-- construction: the predicate requires scored_at IS NULL, so a row that
-- has ever been scored is never a candidate, whatever else is true of
-- it. The prune is additionally reference-aware — issue_pick, eval_label,
-- ground_truth, another story's scored_via_story_id, and the bare
-- issue.story_ids array (which has NO foreign key, so a cascade would
-- not have protected it) all veto deletion.
--
-- 30 days rather than something tight: an unscored row still does work
-- inside the dedup lookback and while a scorer backlog is draining, and
-- a month of noise is a rounding error against the reclaim.
INSERT INTO config (key, value) VALUES
  ('retention.unscored_noise_days', '30'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- The prune predicate leads on scored_at + ingested_at. Without this it
-- is a full scan of the largest table in the database, on a daily stage,
-- on a plan where CU is the cost driver.
CREATE INDEX IF NOT EXISTS story_unscored_ingested_idx
  ON story (ingested_at)
  WHERE scored_at IS NULL;
