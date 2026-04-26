-- Auto-merge threshold for phase-2 theme consolidation. At or above
-- this cosine, reattach merges the pair without invoking the Haiku
-- theme-confirm LLM. Reason: the LLM prompt is calibrated for
-- story→theme ("is this new story a continuation of this theme?")
-- and turned out conservative when reused for theme→theme, rejecting
-- obvious 0.95+ duplicates by inspection. Voyage embeddings at ≥0.95
-- are empirically same-content.
--
-- Window:
--   < theme.merge_threshold (0.85)         → no merge
--   [merge_threshold, merge_auto_threshold) → LLM-gated (borderline)
--   ≥ merge_auto_threshold (0.95)          → auto-merge

INSERT INTO config (key, value) VALUES
  ('theme.merge_auto_threshold', '0.95'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
