-- Curated jargon list for the compose-time gloss-linter (src/shared/
-- gloss-lint.ts). The linter catches bare un-glossed ACRONYMS with a
-- regex; this table holds the NON-acronym specialist names the regex
-- can't see ("Brent", "gilt", "tirzepatide") so the /admin/review panel
-- flags them when they appear un-glossed on first use. Managed at
-- /admin/gloss-terms — operator adds whatever keeps slipping through.
--
-- `hits` counts how many composed drafts used the term un-glossed (bumped
-- at compose time), so the operator can prune terms that never fire and
-- spot the ones that recur. All-caps terms are ignored by the linter
-- (the acronym detector owns those), so the list should stay mixed/
-- lowercase names.

-- Idempotent — see migration 043 for the rationale.
CREATE TABLE IF NOT EXISTS gloss_term (
  term       text PRIMARY KEY,
  note       text,
  hits       int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seed with the non-acronym names the composer prompt's own examples use
-- (or should gloss). Acronyms like OPEC/IRGC are deliberately absent —
-- the regex detector handles them.
INSERT INTO gloss_term (term, note) VALUES
  ('Brent',        'oil price benchmark'),
  ('gilt',         'UK government bond'),
  ('gilts',        'UK government bonds'),
  ('Fed',          'US Federal Reserve'),
  ('amicus',       'amicus brief — outside-party court filing'),
  ('redistricting','redrawing electoral district maps'),
  ('tirzepatide',  'weight-loss / diabetes drug')
ON CONFLICT (term) DO NOTHING;
