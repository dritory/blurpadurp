-- Composer v0.4: paragraphs only, no bulleted or numbered lists.
-- Output format changed so every item in every section is its own
-- paragraph (<p> in HTML, blank-line-separated in markdown). Bullets
-- signal LLM output; paragraphs read as editorial prose.
--
-- Pre-existing issues in the `issue` table still contain the v0.3 HTML
-- with <ul>/<li>. Pre-1.0: no backfill. Rerender via composer-replay if
-- you want a specific issue refreshed.
--
-- Version bump invalidates the composer's ai_call_log cache.

UPDATE config
SET value = '"composer-v0.4"'::jsonb, updated_at = now()
WHERE key = 'composer.prompt_version';
