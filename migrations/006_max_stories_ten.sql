-- Initial cap of 7 felt too tight for a weekly brief.
UPDATE config
SET value = '10'::jsonb, updated_at = now()
WHERE key = 'composer.max_stories';
