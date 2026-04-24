-- Composer v0.6: citations wrapped in <span class="cite"> in HTML so
-- the renderer can style the cluster (parens, commas, links) as one
-- tiny non-wrapping unit. Markdown format unchanged.
--
-- Pre-existing issues keep their old HTML without the span — they'll
-- look slightly off until recomposed. Pre-1.0 no-backfill stance.

UPDATE config
SET value = '"composer-v0.6"'::jsonb, updated_at = now()
WHERE key = 'composer.prompt_version';
