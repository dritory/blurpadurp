-- Composer v0.7: readability rules added to "How to write" — gloss
-- unfamiliar acronyms on first use, hard cap of 30 words per sentence,
-- whole sentences instead of telegraphic fragments, meaning-first then
-- evidence. New "Voice corrections" pair anchors each failure mode.
--
-- Pre-existing issues keep their old prose. Pre-1.0 no-backfill stance.

UPDATE config
SET value = '"composer-v0.7"'::jsonb, updated_at = now()
WHERE key = 'composer.prompt_version';
