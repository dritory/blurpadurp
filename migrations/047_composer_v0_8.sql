-- Composer v0.8: address reader-feedback failure modes.
--   1. "Explain, don't enumerate" — paragraphs that name eight facts and
--      explain none are the dominant complaint. New rule + voice-correction
--      pair built around the observed Hormuz paragraph.
--   2. "Two facts a paragraph, not ten" — soft ceiling complementing
--      the hard "one number, or zero" floor.
--   3. Jargon-gloss rule extended from acronyms to specialist terms
--      (amicus brief, gilt yields, redistricting, Section 122).
--   4. "No American default" — reader could be anywhere; US stories
--      are framed as US stories.
--   5. Worth-watching clarified: not every tail item is forward-looking;
--      obituaries read as observations, not invented open questions.
--
-- Pre-existing issues keep their old prose. Pre-1.0 no-backfill stance.

UPDATE config
SET value = '"composer-v0.8"'::jsonb, updated_at = now()
WHERE key = 'composer.prompt_version';
