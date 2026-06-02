-- Denormalize the scorer's one-line summary out of raw_output into a
-- dedicated column. Two reasons (see docs/storage.md):
--   1. The hot scoring path (loadThemeContext, theme-continuation, and
--      the embedding-text builder) only needs this one string from
--      raw_output. Reading the whole jsonb to pluck one field is
--      wasteful per score cycle.
--   2. It decouples the hot path from raw_output, which is the
--      prerequisite for moving raw_output to cold storage (R2) later
--      without touching scoring.

ALTER TABLE story ADD COLUMN scorer_summary text;

-- Backfill from existing raw_output. v0.2 scorer prompt stores
-- `summary`; v0.1 stored `one_line_summary`.
UPDATE story
SET scorer_summary = NULLIF(
  trim(COALESCE(raw_output->>'summary', raw_output->>'one_line_summary', '')),
  ''
)
WHERE raw_output IS NOT NULL
  AND scorer_summary IS NULL;
