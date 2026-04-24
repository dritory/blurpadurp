-- Semantic dedup: if a near-neighbor story was already scored within
-- the lookback window, the new story inherits its scores verbatim and
-- skips the (expensive) scorer LLM call.
--
-- The inheriting row stores the neighbor's raw_output (so composer and
-- editor can read summary/retrodiction as usual), but its raw_input
-- stays NULL to signal "we did not actually call the scorer here."
-- scored_via_story_id points at the donor for auditability and to
-- prevent inheritance chains (neighbors with scored_via_story_id IS
-- NOT NULL are excluded from the search).

ALTER TABLE story
  ADD COLUMN IF NOT EXISTS scored_via_story_id bigint
  REFERENCES story(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS story_scored_via_idx
  ON story(scored_via_story_id)
  WHERE scored_via_story_id IS NOT NULL;

INSERT INTO config (key, value) VALUES
  ('scorer.dedup_enabled',              'true'::jsonb),
  ('scorer.dedup_similarity_threshold', '0.95'::jsonb),
  ('scorer.dedup_lookback_days',        '3'::jsonb)
ON CONFLICT (key) DO NOTHING;
