-- Editor v0.2: arc picks + themes digest + per-story dates.
-- Composer v0.3: arc-writing register + gold example.
-- Both version bumps invalidate their respective ai_call_log caches.

UPDATE config
SET value = '"editor-v0.2"'::jsonb, updated_at = now()
WHERE key = 'editor.prompt_version';

UPDATE config
SET value = '"composer-v0.3"'::jsonb, updated_at = now()
WHERE key = 'composer.prompt_version';
