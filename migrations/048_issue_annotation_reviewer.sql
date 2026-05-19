-- Draft preview links with attributable feedback.
--
-- Before: notes on a draft could only be left by an admin (basic-auth
-- gated /admin/review/:id). That blocks a common workflow — sending a
-- draft to a non-admin reviewer (a partner, an editor) for sanity-check
-- feedback before publishing.
--
-- After: signed magic-link tokens (kind=draft-preview, see
-- src/shared/tokens.ts) carry an issue_id + reviewer name. The token
-- holder gets a read-only render of the draft plus a feedback form that
-- writes back to issue_annotation. Notes left this way carry the
-- reviewer's name; admin notes leave reviewer_name NULL.
--
-- CHECK enforces non-empty when set so we never store reviewer_name=''
-- by accident from a form that didn't validate.

ALTER TABLE issue_annotation
  ADD COLUMN reviewer_name text
    CHECK (reviewer_name IS NULL OR length(reviewer_name) > 0);
