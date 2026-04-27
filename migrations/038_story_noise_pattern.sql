-- Tag-only URL classifier output. Stories whose source_url matches a
-- "noise" path pattern (e.g. /entertainment/, /viral/) get the matched
-- pattern recorded here at ingest. Tagging only — nothing downstream
-- filters on this yet. Lets us measure false-positive rate before
-- promoting any pattern to a hard ingest filter.
--
-- Patterns mirror src/shared/url-noise.ts; backfill below uses the
-- same substring rules.

ALTER TABLE story ADD COLUMN noise_pattern text;

UPDATE story
SET noise_pattern = CASE
  WHEN lower(source_url) LIKE '%/entertainment/%' THEN '/entertainment/'
  WHEN lower(source_url) LIKE '%/viral/%' THEN '/viral/'
  ELSE NULL
END
WHERE source_url IS NOT NULL
  AND (
    lower(source_url) LIKE '%/entertainment/%'
    OR lower(source_url) LIKE '%/viral/%'
  );

CREATE INDEX story_noise_pattern_idx
  ON story (noise_pattern)
  WHERE noise_pattern IS NOT NULL;
