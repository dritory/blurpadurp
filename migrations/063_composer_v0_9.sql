-- Composer v0.9: gloss-discipline pass.
--   1. Gold-example fix — the acronym-soup correction wrote "Brent is at
--      $126" with no gloss while glossing OPEC right beside it, teaching
--      the bare-jargon habit it's meant to ban. Now "Brent crude, the
--      oil benchmark, is at $126".
--   2. The jargon-gloss rule names "Brent crude" explicitly and spells
--      out that a non-acronym specialist name (Brent, the Knesset,
--      tirzepatide) needs context on first use too.
--
-- The rule itself is unchanged — this stops the examples undercutting
-- it. A deterministic gloss-linter (src/shared/gloss-lint.ts) now backs
-- the prompt: it flags un-glossed acronyms and curated jargon on the
-- /admin/review page so stragglers are caught before publish. The
-- curated jargon list lives in gloss_term (mig 062).
--
-- Bumping the version string invalidates composer cache-on-hash lookups,
-- forcing fresh output against the corrected prompt.

UPDATE config
SET value = '"composer-v0.9"'::jsonb, updated_at = now()
WHERE key = 'composer.prompt_version';
