-- URL path-segment filter. Patterns matched as substrings against
-- lowercased source_url at ingest. Each row is either:
--   * mode='block' — story is dropped before persist (no embedding,
--     no scoring spend)
--   * mode='tag'   — story is persisted with story.noise_pattern set;
--     useful for evaluating false-positive rate before promoting to
--     'block'
--
-- Replaces the hardcoded list in src/shared/url-noise.ts. Operator
-- manages via /admin/path-filters.

-- Idempotent (CREATE TABLE IF NOT EXISTS + INSERT … ON CONFLICT DO
-- NOTHING) so prod can run this safely even if the table was created
-- out-of-band — same defensive pattern as migration 043.
CREATE TABLE IF NOT EXISTS url_path_filter (
  pattern    text PRIMARY KEY,
  mode       text NOT NULL DEFAULT 'block' CHECK (mode IN ('block','tag')),
  hits       int  NOT NULL DEFAULT 0,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The two patterns from migration 038 stay in 'tag' mode so existing
-- tagged story rows keep their noise_pattern values consistent. Promote
-- to 'block' from /admin/path-filters once the false-positive rate
-- reads acceptable.
INSERT INTO url_path_filter (pattern, mode, note) VALUES
  ('/entertainment/', 'tag',   'auto-promoted from migration 038'),
  ('/viral/',         'tag',   'auto-promoted from migration 038')
ON CONFLICT (pattern) DO NOTHING;

-- Starter pack of paths that are reliably low-signal across most
-- outlets. /opinion/ is intentionally absent — NYT/Economist/FT
-- op-eds are signal, not noise. /arts/ and /books/ also absent;
-- review-driven and often substantive. Operator can add via UI.
INSERT INTO url_path_filter (pattern, mode, note) VALUES
  ('/sport/',     'block', 'starter pack'),
  ('/sports/',    'block', 'starter pack'),
  ('/celebrity/', 'block', 'starter pack'),
  ('/lifestyle/', 'block', 'starter pack'),
  ('/horoscope/', 'block', 'starter pack'),
  ('/recipes/',   'block', 'starter pack'),
  ('/style/',     'block', 'starter pack'),
  ('/fashion/',   'block', 'starter pack'),
  ('/travel/',    'block', 'starter pack'),
  ('/food/',      'block', 'starter pack'),
  ('/gaming/',    'block', 'starter pack'),
  ('/tv/',        'block', 'starter pack'),
  ('/movies/',    'block', 'starter pack'),
  ('/music/',     'block', 'starter pack')
ON CONFLICT (pattern) DO NOTHING;

-- Backfill the hits column for the two 'tag' patterns from existing
-- story rows so the admin UI shows real counts on day one rather than
-- starting at zero.
UPDATE url_path_filter f
SET hits = sub.n
FROM (
  SELECT noise_pattern AS pattern, count(*)::int AS n
  FROM story
  WHERE noise_pattern IS NOT NULL
  GROUP BY noise_pattern
) sub
WHERE f.pattern = sub.pattern;
