-- Composer v0.10: catch-up items get dated.
--
-- mig 067 let a catch-up run add stories older than the brief's own
-- week, and told the EDITOR how to weigh them (editor v0.5). It never
-- told the composer, which writes the actual prose — and every framing
-- rule in composer-prompt.md assumes the last seven days, down to a
-- gold example that writes "warned this week".
--
-- So a 21-day-old story was rendered as fresh news. Not a tone problem:
-- the brief would be stating something false to the reader.
--
-- v0.10 adds a "Catch-up items" section — date it in the first
-- sentence, no present-week deixis, lead on why it still matters, no
-- apologetic meta — and the composer input now carries catch_up +
-- age_days per story (the flag renders only for catch-up stories, so a
-- normal run's prompt is byte-identical to v0.9 and its cache entries
-- still hit).
--
-- Bumping the version string invalidates composer cache-on-hash lookups,
-- forcing fresh output against the corrected prompt.

UPDATE config
SET value = '"composer-v0.10"'::jsonb, updated_at = now()
WHERE key = 'composer.prompt_version';
