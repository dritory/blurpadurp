-- Composer v0.8: address reader-feedback failure modes.
--   1. "Explain the essence, not the trivia" — paragraphs that name
--      many facts and explain none are the dominant complaint. The
--      fix isn't fact-count but identifying which facts carry the
--      story. New rule + voice-correction pair built around the
--      observed Hormuz paragraph.
--   2. Jargon-gloss extended from acronyms to specialist terms
--      (amicus brief, gilt yields, redistricting, Section 122, AIS),
--      with multiple phrasings allowed so the gloss doesn't read as
--      mechanical.
--   3. "World brief, not US brief" — reader could be anywhere; US
--      stories framed as one country's news among many.
--   4. Worth-watching clarified: not every tail item is forward-looking;
--      obituaries read as observations, not invented open questions.
--   5. Tone pass — editorial-voice header rewritten around an
--      explanatory register (Espresso + Designing Data-Intensive
--      Applications as touchstones), several Voice-correction "Better"
--      rewrites de-snarked, chyron-rhythm headlines (colon-subtitle
--      lists, anchor clichés) explicitly banned. The 30-word sentence
--      cap softened to "sentences should be honest" — length is fine
--      when it's doing real explanatory work, not stacking clauses.
--
-- Pre-existing issues keep their old prose. Pre-1.0 no-backfill stance.

UPDATE config
SET value = '"composer-v0.8"'::jsonb, updated_at = now()
WHERE key = 'composer.prompt_version';
