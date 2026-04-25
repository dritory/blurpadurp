-- Cap any single category's share of the editor pool to prevent
-- politics (or any other category) from dominating just because the
-- gate-passer pool is skewed. Strict gate is still the floor — a
-- weak story in an under-represented category does NOT get pulled in
-- to balance. The cap only ELIMINATES over-representation; it never
-- forces minimums.
--
-- 0.5 means a single category can take at most 50% of the pool's
-- target story count. Once that cap is hit, additional themes from
-- the same category drop to "excluded" and the pool slot goes to the
-- next-best theme of any other category. If no other category has
-- candidates, pool just fills less — silence over forced filler.
INSERT INTO config (key, value) VALUES
  ('editor.pool_max_category_fraction', '0.5'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
