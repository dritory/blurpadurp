-- Turn on progressive scoring. Phase 1 runs every unscored story
-- through a cheaper prefilter pass (no theme context, smaller
-- max_tokens, same model for now); phase 2 runs full scoring only
-- on the top fraction by prefilter composite. Stories the prefilter
-- early-rejects skip phase 2 entirely.
--
-- Same model as the main scorer (Haiku 4.5) — the saving comes from
-- skipping the second pass on the bottom 70% and from the smaller
-- per-call payload, not from a cheaper model. Swap to claude-haiku-3-5
-- here if you want extra savings at some quality cost.
--
-- Tunable on /admin/config without re-running this migration:
--   scorer.prefilter_model_id     — null disables the whole prefilter
--   scorer.prefilter_top_fraction — slice of pool that gets full scoring
--   scorer.prefilter_max_tokens   — output cap for the cheap pass
UPDATE config
SET value = '"claude-haiku-4-5-20251001"'::jsonb,
    updated_at = now()
WHERE key = 'scorer.prefilter_model_id';
