-- Bump scorer prompt to v0.2 — compressed system prompt + strict length
-- caps on free-text reasoning fields. Changing the version string also
-- invalidates the scorer's cache-on-hash lookups (cache keyed on
-- stage_version), forcing fresh responses against the new prompt.

UPDATE config
SET value = '"prompt-v0.2"'::jsonb, updated_at = now()
WHERE key = 'scorer.prompt_version';
