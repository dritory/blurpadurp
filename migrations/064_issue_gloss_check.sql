-- Persist the on-demand checker result on the issue row
-- (src/ai/checker.ts). The operator triggers the check from
-- /admin/review; the result needs to survive the post-redirect
-- re-render (and be visible to draft reviewers), so it's stored rather
-- than held in memory. Nullable — null means "not checked yet" (and is
-- reset to null whenever the brief is re-composed/edited, since stored
-- findings refer to specific prose).
--
-- Shape is CheckResult (check-schema.ts): { checked_at, model_id,
-- prompt_version, findings[] } where each finding is task-tagged
-- (today the only task is "gloss"). Advisory only — never feeds the
-- published brief; the deterministic linter (gloss-lint.ts) still runs
-- read-only on every review page load regardless.

ALTER TABLE issue
  ADD COLUMN IF NOT EXISTS check_jsonb jsonb;
