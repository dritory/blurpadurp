-- Gloss-linter: an operator-managed IGNORE list.
--
-- The deterministic linter (src/shared/gloss-lint.ts) flags every
-- all-caps token that isn't on its hard-coded bare-acronym whitelist.
-- That whitelist had twelve entries, so ubiquitous org/brand acronyms —
-- BBC, IBM, CNN, NHS, IMF — were flagged as un-glossed every single
-- issue. The AI checker correctly dismissed them, which left the two
-- layers openly contradicting each other on the review page, and the
-- operator had no way to make a recurring false alarm go away.
--
-- Widening the hard-coded whitelist covers the predictable cases (done
-- in the same change), but the tail is unbounded and the operator is the
-- one who sees it. So gloss_term becomes two lists in one table:
--
--   is_ignored = false  → WATCH: a specialist name to flag when bare
--                         (the original purpose — "Brent", "gilt")
--   is_ignored = true   → IGNORE: a term neither the linter nor the AI
--                         checker should ever flag
--
-- One table because the terms share a namespace: a term is watched,
-- ignored, or absent, and those are mutually exclusive by construction
-- when `term` is the primary key. Ignore rows may be all-caps (that's
-- the whole point); watch rows still may not.

-- Idempotent — see migration 043 for the rationale.
ALTER TABLE gloss_term
  ADD COLUMN IF NOT EXISTS is_ignored boolean NOT NULL DEFAULT false;

-- Seed the acronyms the operator reported as false alarms, plus the
-- near neighbours that would have been reported next week. These are
-- deliberately NOT in the code whitelist: brand/org names are a matter
-- of editorial judgment and drift with the newsroom mix, so they live
-- where the operator can edit them. The code whitelist keeps only the
-- acronyms that are bare by rule (US, UK, EU, NATO, …).
INSERT INTO gloss_term (term, note, is_ignored) VALUES
  ('BBC',    'broadcaster — recognised bare',          true),
  ('IBM',    'company name — recognised bare',         true),
  ('CNN',    'broadcaster — recognised bare',          true),
  ('NPR',    'broadcaster — recognised bare',          true),
  ('AP',     'news agency — recognised bare',          true),
  ('NBC',    'broadcaster — recognised bare',          true),
  ('CBS',    'broadcaster — recognised bare',          true),
  ('ABC',    'broadcaster — recognised bare',          true),
  ('ITV',    'broadcaster — recognised bare',          true),
  ('AFP',    'news agency — recognised bare',          true),
  ('CNBC',   'broadcaster — recognised bare',          true),
  ('HP',     'company name — recognised bare',         true),
  ('BMW',    'company name — recognised bare',         true),
  ('TV',     'ordinary English',                       true),
  ('PC',     'ordinary English',                       true),
  ('DNA',    'ordinary English',                       true),
  ('COVID',  'ordinary English by now',                true),
  ('OK',     'ordinary English',                       true)
ON CONFLICT (term) DO NOTHING;

-- The list is read on every compose, every auto-fix pass and every
-- review-page load, and it is small — but the ignore/watch split is
-- always filtered, so index it rather than seq-scanning under the
-- free-tier CU budget.
CREATE INDEX IF NOT EXISTS gloss_term_is_ignored_idx
  ON gloss_term (is_ignored);
