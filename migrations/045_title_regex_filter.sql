-- Title regex filter. Mirrors url_path_filter (mig 044) but matches
-- against story.title via JS RegExp at ingest. Always case-insensitive
-- — operators rarely want case-sensitive matches on news titles. Each
-- row is either:
--   * mode='block' — story dropped before persist
--   * mode='tag'   — story persisted with story.noise_title_pattern set
--
-- Patterns are validated at insert time via /admin/title-filters/add
-- (the route compiles the regex; an invalid one returns a flash error
-- instead of writing the row). Loader still try-catches each row at
-- runtime so a bad row never breaks ingest.

CREATE TABLE title_regex_filter (
  pattern    text PRIMARY KEY,
  mode       text NOT NULL DEFAULT 'block' CHECK (mode IN ('block','tag')),
  hits       int  NOT NULL DEFAULT 0,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Conservative seed: a couple of unambiguous patterns and one
-- explainer-bait pattern in tag mode for evaluation. Operator adds
-- more from /admin/title-filters once they see what slips through.
INSERT INTO title_regex_filter (pattern, mode, note) VALUES
  ('^\d+\s+(best|worst|things|reasons|ways|tips|tricks|signs)\b',
     'block', 'starter pack: listicle openings'),
  ('\byou won''t believe\b',
     'block', 'starter pack: classic clickbait'),
  ('\b(goes|went)\s+viral\b',
     'tag',   'starter pack: virality framing — audit before block');
