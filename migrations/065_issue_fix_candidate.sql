-- A pending, non-destructive "fix proposal" for a draft, produced by the
-- checker's Re-compose-to-fix path (src/api/admin.tsx /check-fix). The
-- recompose does NOT overwrite the draft prose; instead the candidate
-- output is stashed here and shown on /admin/review as a preview, applied
-- to composed_markdown/html/title only on an explicit Accept (and dropped
-- on Discard or whenever the draft is otherwise re-composed/re-edited,
-- which would make the candidate stale).
--
-- Shape is FixCandidate (check-schema.ts): { created_at, notes[],
-- title, composed_markdown, composed_html, prompt_version, model_id,
-- check } where `check` is the re-check (CheckResult) of the candidate
-- prose so the panel can show "after" findings. Nullable — null means
-- "no proposal pending".

ALTER TABLE issue
  ADD COLUMN IF NOT EXISTS fix_candidate_jsonb jsonb;
