-- Editor stage sits between gate and compose. It picks the 10–15 story
-- shortlist that makes the strongest issue, using LLM judgment over a
-- larger pool than the top-N-by-composite cap could. Retires
-- composer.max_stories — the editor's pick count now drives issue size.

INSERT INTO config (key, value) VALUES
  ('editor.model_id',         '"claude-sonnet-4-6"'::jsonb),
  ('editor.prompt_version',   '"editor-v0.1"'::jsonb),
  ('editor.max_tokens',       '2000'::jsonb),
  ('editor.pool_size',        '60'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

DELETE FROM config WHERE key = 'composer.max_stories';
