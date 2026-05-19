-- Defensive backfill: assign published_seq to any published issue that
-- somehow lacks one. Migration 041 ran the original backfill, but a
-- row turned up in prod with is_draft=false AND published_seq IS NULL,
-- which made /admin/review and the public /, /issue, /archive surfaces
-- fall back to the surrogate id (the "draft number" the user kept
-- seeing).
--
-- We don't know the exact cause — publishDraft sets both columns
-- atomically and compose only inserts drafts, so the most likely
-- explanations are an out-of-band psql insert or a partial earlier
-- migration. The fix is the same regardless: assign the next number
-- in published_at order to anything missing one.
--
-- Numbering: continue from the current max(published_seq) rather than
-- renumbering everything from 1, so existing reader-facing labels
-- ("Issue #4", "Issue #5", ...) don't shift.
--
-- Idempotent and safe to re-run: the WHERE clause filters to rows that
-- are missing the column, so a second run does nothing.

WITH ordered AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY published_at, id) AS rn
  FROM issue
  WHERE NOT is_draft
    AND published_seq IS NULL
),
base AS (
  SELECT coalesce(max(published_seq), 0) AS m
  FROM issue
  WHERE published_seq IS NOT NULL
)
UPDATE issue
SET published_seq = base.m + ordered.rn
FROM ordered, base
WHERE issue.id = ordered.id;

-- Lock it in. After the backfill above, every published row has a
-- number; any future code path that flips is_draft=false without
-- assigning published_seq now fails at the database layer instead
-- of silently producing a "draft-numbered" public issue.
-- Drop-then-add so re-runs are safe (same pattern as 043-048).
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_published_seq_required;
ALTER TABLE issue
  ADD CONSTRAINT issue_published_seq_required
  CHECK (is_draft = true OR published_seq IS NOT NULL);
