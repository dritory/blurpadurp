-- Editor v0.3: structural_importance + steelman_important + base_rate_per_year
-- surfaced to the editor, plus a pre-computed pool_composition digest with
-- quiet-but-significant and loud-but-insignificant cohort flags. Previous
-- versions effectively saw one axis (zeitgeist) and over-picked stenography.
--
-- This UPDATE invalidates the ai_call_log cache for editor calls at v0.2
-- since findCachedOutput keys on stage_version.

UPDATE config
SET value = '"editor-v0.3"'::jsonb, updated_at = now()
WHERE key = 'editor.prompt_version';
