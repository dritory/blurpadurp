-- editor.pool_size was a story count — a holdover from before the
-- theme-first pool refactor (commit 13170ed). Now that pool selection
-- is theme-first, themes are the natural unit. Add an explicit
-- editor.pool_max_themes (primary cap) and keep pool_size as a
-- fallback story safety cap so no runaway theme can blow up the
-- editor's input token budget.
--
-- Default 20 themes ≈ 60-120 stories at typical arc sizes. Editor
-- still picks 10-15 from this pool, so 20 candidate themes gives the
-- editor real choice without overwhelming the LLM context.
INSERT INTO config (key, value) VALUES
  ('editor.pool_max_themes', '20'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
