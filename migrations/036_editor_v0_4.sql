-- Editor v0.4: surface wikipedia_corroborated theme flag. Wikipedia
-- entries (ITN + Current Events portal) are filtered out of the
-- editor pool — they're external editorial endorsement, not stories
-- to write about. A theme picking up a Wikipedia member flags as
-- corroborated and biases editor inclusion, especially for
-- quiet-but-significant picks.
--
-- This UPDATE invalidates the ai_call_log cache for editor calls at
-- v0.3 since findCachedOutput keys on stage_version.

UPDATE config
SET value = '"editor-v0.4"'::jsonb, updated_at = now()
WHERE key = 'editor.prompt_version';
