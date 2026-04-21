-- Bump composer prompt to v0.2 — switches from theme-based grouping to
-- four fixed functional sections (This week's conversation / Worth knowing
-- / Worth watching / Worth a shrug). See docs/concept.md#section-scheme.
-- Changing the version string invalidates composer cache-on-hash lookups,
-- forcing fresh output against the new structure.

UPDATE config
SET value = '"composer-v0.2"'::jsonb, updated_at = now()
WHERE key = 'composer.prompt_version';
