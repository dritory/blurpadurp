-- Persist the on-demand LLM gloss-check result on the issue row
-- (src/ai/gloss-checker.ts). The operator triggers the check from
-- /admin/review; the result needs to survive the post-redirect re-render
-- (and be visible to draft reviewers), so it's stored rather than held in
-- memory. Nullable — null means "not checked yet". Shape is
-- GlossCheckResult (gloss-check-schema.ts): { checked_at, model_id,
-- prompt_version, findings[] }.
--
-- Advisory only: this column never feeds the published brief. The
-- deterministic linter (gloss-lint.ts) still runs read-only on every
-- review page load regardless of whether this has been populated.

ALTER TABLE issue
  ADD COLUMN IF NOT EXISTS gloss_check_jsonb jsonb;
