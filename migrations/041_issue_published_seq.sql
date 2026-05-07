-- Public-facing issue numbering. `issue.id` is a bigserial that increments
-- on every insert — including drafts that get discarded — so it's not
-- gap-free and not safe to show readers as "Issue #N". This column is
-- assigned only when a draft is published, by publishDraft, so the
-- sequence stays gap-free even when a draft is composed-then-discarded.
--
-- Backfill: existing published issues get a number in publish-order
-- (published_at, then id as tie-breaker). Drafts stay NULL — they pick
-- up a number when they're actually published.
--
-- The unique partial index lets multiple drafts coexist with NULL while
-- preventing two published issues from ever sharing the same public
-- number.

ALTER TABLE issue ADD COLUMN published_seq int;

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY published_at, id) AS rn
  FROM issue
  WHERE NOT is_draft
)
UPDATE issue
SET published_seq = ordered.rn
FROM ordered
WHERE issue.id = ordered.id;

CREATE UNIQUE INDEX issue_published_seq_idx
  ON issue (published_seq)
  WHERE published_seq IS NOT NULL;
