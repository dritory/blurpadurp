-- Release console + catch-up (retro) composition.
--
-- 1. PARAMETERIZED STAGE TRIGGERS. /admin/run/:stage could say "run
--    compose" but never "run compose LIKE THIS" — pipeline_force_run
--    was (stage, requested_at) with nowhere to put an argument. That is
--    the only reason every parameterized operation stayed CLI-only.
--    One jsonb column opens the whole set to the web.
--
--    stage stays the PRIMARY KEY (it caps the queue at one pending run
--    per stage, which is the behaviour we want), but /admin/run now
--    UPSERTs instead of DO NOTHING so a later request with different
--    args replaces an earlier one rather than being silently dropped.
--
-- 2. CATCH-UP WINDOW. compose has a hard 7-day freshness gate
--    (COMPOSE_STORY_MAX_AGE_MS). After a gap in publishing, everything
--    older than a week is invisible to the editor and is never
--    published — it just ages out. These keys let one run reach further
--    back for a bounded number of extra picks.
--
--    Crucially the catch-up pool is ranked on structural_importance ×
--    half_life and IGNORES passed_gate, rather than widening the
--    normal window. The gate is explicitly "discussed NOW"
--    (docs/scoring-prompt.md) — zeitgeist is a point-in-time
--    measurement, so re-ranking three-week-old stories by composite
--    would sort them by how loud they were three weeks ago and produce
--    a stale trending list. structural_importance is the durable axis,
--    is already scored on every story, and deliberately does NOT enter
--    the composite (docs/scoring.md). A gate-failing story can be
--    highly structural — that's the quiet×significant quadrant the
--    editor rubric already asks for.
--
-- 3. EDITOR v0.5. Hard rule #2 asserted "everything in the pool has
--    already passed the gate", which catch-up items violate. The prompt
--    now describes the catch_up flag and how to treat it. Version bump
--    per CLAUDE.md invariant #6 — the cache is keyed on it.

ALTER TABLE pipeline_force_run ADD COLUMN args jsonb;

INSERT INTO config (key, value) VALUES
  -- How far back a catch-up run may reach. The normal 7-day freshness
  -- window is unchanged and still governs the main pool.
  ('compose.retro_window_days', '21'::jsonb),
  -- Ceiling on catch-up picks entering the editor pool. Deliberately
  -- small: this is "what mattered while we were quiet", not a dump.
  -- Silence is still a feature (CLAUDE.md invariant #1).
  ('compose.retro_max_items', '8'::jsonb)
ON CONFLICT (key) DO NOTHING;

UPDATE config
SET value = '"editor-v0.5"'::jsonb, updated_at = now()
WHERE key = 'editor.prompt_version';
