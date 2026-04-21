-- Progressive scoring: cheap model pre-filters, expensive model does the
-- final pass on only the top fraction by prefilter composite. Cuts
-- scoring cost ~3-10x at the cost of a few missed borderline items.
--
-- These columns are populated by the prefilter pass; the main scoring
-- fields (scored_at, raw_output, composite, ...) are only populated by
-- the final pass. A story with first_pass_scored_at IS NOT NULL but
-- scored_at IS NULL was looked at by the cheap model and dropped.

ALTER TABLE story
  ADD COLUMN first_pass_composite numeric,
  ADD COLUMN first_pass_model_id text,
  ADD COLUMN first_pass_prompt_version text,
  ADD COLUMN first_pass_scored_at timestamptz;

CREATE INDEX story_first_pass_composite_idx
  ON story (first_pass_composite DESC)
  WHERE first_pass_scored_at IS NOT NULL AND scored_at IS NULL;

-- Config knobs. prefilter_model_id = null disables prefilter entirely
-- (back to single-pass). prefilter_top_fraction of 0.30 means the top
-- 30% of stories by prefilter composite get a final-pass scoring; the
-- rest are left with first_pass_* populated but never fully scored.
INSERT INTO config (key, value) VALUES
  ('scorer.prefilter_model_id',      'null'::jsonb),
  ('scorer.prefilter_prompt_version','"prompt-v0.2"'::jsonb),
  ('scorer.prefilter_top_fraction',  '0.30'::jsonb),
  ('scorer.prefilter_max_tokens',    '1500'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
