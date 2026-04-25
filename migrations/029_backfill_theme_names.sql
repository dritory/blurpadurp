-- Backfill theme.name where the original first-story summary was
-- empty (scorer.ts now falls back to story.title for new themes).
-- For each empty-name theme, pick the member story with the longest
-- non-empty summary; if all members have empty summaries, fall back
-- to the story's title.

WITH best AS (
  SELECT DISTINCT ON (theme_id)
    theme_id,
    -- COALESCE the first non-empty option in priority order:
    --   1. v0.2 summary field
    --   2. v0.1 one_line_summary (older rows)
    --   3. story.title (always non-empty)
    COALESCE(
      NULLIF(trim(raw_output->>'summary'), ''),
      NULLIF(trim(raw_output->>'one_line_summary'), ''),
      title
    ) AS new_name
  FROM story
  WHERE theme_id IS NOT NULL
  ORDER BY
    theme_id,
    -- Prefer rows with a longer summary; ties break by lowest id
    -- (chronological), so theme names stay stable across re-runs.
    length(COALESCE(raw_output->>'summary', raw_output->>'one_line_summary', '')) DESC,
    id ASC
)
UPDATE theme t
SET name = substring(b.new_name FROM 1 FOR 200)
FROM best b
WHERE t.id = b.theme_id
  AND (t.name IS NULL OR trim(t.name) = '');
