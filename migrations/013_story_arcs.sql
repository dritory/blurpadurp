-- Story arcs: editor may now emit multi-story picks on a shared theme,
-- and the composer weaves them into a single chronological paragraph.
-- Both prompt versions bump; both caches invalidate.

UPDATE config
SET value = '"editor-v0.2"'::jsonb, updated_at = now()
WHERE key = 'editor.prompt_version';

UPDATE config
SET value = '"composer-v0.3"'::jsonb, updated_at = now()
WHERE key = 'composer.prompt_version';
