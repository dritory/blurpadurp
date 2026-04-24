-- Composer v0.5: issue gets a dedicated `title` column, populated by
-- the composer's new `title` tool field. Existing rows predate the
-- field and get NULL — the reader falls back to the date-based header.
--
-- Originally numbered 016_issue_title.sql; renumbered to 019 after a
-- remote pull brought in a 016_editor_v0_3.sql. IF NOT EXISTS guard
-- handles DBs that already applied this under the old filename.

ALTER TABLE issue ADD COLUMN IF NOT EXISTS title text;

UPDATE config
SET value = '"composer-v0.5"'::jsonb, updated_at = now()
WHERE key = 'composer.prompt_version';
